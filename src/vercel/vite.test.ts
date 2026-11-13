import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { reactRouterAdapter } from "../react-router/vite.js";
import { appServer } from "../vite/index.js";
import { vercel } from "./vite.js";

const root = mkdtempSync(join(tmpdir(), "app-server-vercel-"));
const clientDirectory = join(root, "build/client");
const entryFile = join(root, "build/server/app-server.js");
const output = join(root, ".vercel/output");
const functionDirectory = join(output, "functions/index.func");

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A logger for a test that does not read the build log. */
const quiet = { info: () => {}, warn: () => {} };

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/** Each file under `directory`, relative to it, in code unit order. */
function filesUnder(directory: string): string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.toSorted();
}

/**
 * The source of a server entry whose `staticPages` gives `pages`. The body of
 * each page that the CDN serves is `CDN <path>`.
 */
function entrySource(pages: readonly object[] = []): string {
	return [
		`const pages = ${JSON.stringify(pages)};`,
		"export const appServer = {",
		"\tstaticPages: async function* () {",
		'\t\tfor (const page of pages) yield "cdn" in page ? { ...page, cdn: { ...page.cdn, body: new TextEncoder().encode("CDN " + page.path) } } : page;',
		"\t},",
		"\tstopPlugins: async () => {},",
		"};",
		"",
	].join("\n");
}

function json(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

write(join(clientDirectory, "assets/app-abc.js"), "app();");
write(join(clientDirectory, "assets/.app-abc.js.gz"), "gzip");
write(join(clientDirectory, "blog-assets/logo.svg"), "<svg/>");
write(join(clientDirectory, "assets/.private/key.json"), "secret");
write(join(root, "shared/icon.svg"), "<svg/>");
symlinkSync(join(root, "shared"), join(clientDirectory, "blog-assets/shared"));
write(join(clientDirectory, "about/index.html"), "<h1>About</h1>");
// Why: a link to a parent directory must not make the walk endless.
symlinkSync("..", join(clientDirectory, "about/up"));
write(join(clientDirectory, "robots.txt"), "User-agent: *");
write(join(clientDirectory, ".app-server.json"), "{}");
write(entryFile, `import "./chunk.js";\n${entrySource()}`);
write(join(root, "build/server/chunk.js"), "export {};\n");
write(join(output, "stale.txt"), "from an earlier build");

describe("vercel", () => {
	it("writes the CDN files, through links and with no dot path, the function, and the routes", () => {
		const host = vercel({
			cdnPaths: ["/blog-assets/"],
			cdnHeaders: { "Access-Control-Allow-Origin": "*" },
			regions: ["iad1"],
		});

		host.output?.({ root, clientDirectory, entryFile, assetsPath: "/assets/", logger: quiet });

		expect(filesUnder(output)).toStrictEqual([
			"config.json",
			"functions/index.func/.vc-config.json",
			"functions/index.func/build/client/.app-server-files.json",
			"functions/index.func/build/client/.app-server.json",
			"functions/index.func/build/client/about/index.html",
			"functions/index.func/build/client/robots.txt",
			"functions/index.func/build/server/app-server.js",
			"functions/index.func/build/server/chunk.js",
			"functions/index.func/build/server/vercel-function.js",
			"static/assets/app-abc.js",
			"static/blog-assets/logo.svg",
			"static/blog-assets/shared/icon.svg",
		]);
		expect(readFileSync(join(functionDirectory, "build/server/vercel-function.js"), "utf8")).toBe(
			[
				`import { appServer, hostModule } from "./app-server.js";`,
				`export default hostModule.handler(appServer);`,
				"",
			].join("\n"),
		);

		expect(json(join(functionDirectory, ".vc-config.json"))).toStrictEqual({
			runtime: `nodejs${process.versions.node.split(".")[0]}.x`,
			handler: "build/server/vercel-function.js",
			launcherType: "Nodejs",
			supportsResponseStreaming: true,
			regions: ["iad1"],
		});
		expect(json(join(output, "config.json"))).toStrictEqual({
			version: 3,
			routes: [
				{ handle: "filesystem" },
				{ src: "^/(.*)$", dest: "/index" },
				{ handle: "hit" },
				{
					src: "^/blog-assets/.*$",
					headers: { "Access-Control-Allow-Origin": "*" },
					continue: true,
				},
				{
					src: "^/assets/.*$",
					headers: {
						"Access-Control-Allow-Origin": "*",
						"Cache-Control": "public, max-age=31536000, immutable",
					},
					continue: true,
				},
			],
		});
	});

	it("copies the client build once when it is inside the server build", () => {
		const nested = mkdtempSync(join(tmpdir(), "app-server-vercel-nested-"));
		onTestFinished(() => {
			rmSync(nested, { recursive: true, force: true });
		});
		write(join(nested, "dist/app-server.js"), entrySource());
		write(join(nested, "dist/client/assets/app-abc.js"), "app();");
		write(join(nested, "dist/client/robots.txt"), "User-agent: *");

		vercel().output?.({
			root: nested,
			clientDirectory: join(nested, "dist/client"),
			entryFile: join(nested, "dist/app-server.js"),
			assetsPath: "/assets/",
			logger: quiet,
		});

		expect(filesUnder(join(nested, ".vercel/output/functions/index.func/dist"))).toStrictEqual([
			"app-server.js",
			"client/.app-server-files.json",
			"client/robots.txt",
			"vercel-function.js",
		]);
	});

	it("keeps only the brotli copy of a file that has one in the function, and lists the size of each file and the time of the build", () => {
		const site = mkdtempSync(join(tmpdir(), "app-server-vercel-brotli-only-"));
		onTestFinished(() => {
			rmSync(site, { recursive: true, force: true });
		});
		write(join(site, "build/server/app-server.js"), entrySource());
		write(join(site, "build/client/blog/index.html"), "<h1>Blog</h1>");
		write(join(site, "build/client/blog/.index.html.gz"), "gzip");
		write(join(site, "build/client/blog/.index.html.br"), "br");
		write(join(site, "build/client/feed.xml"), "<rss/>");
		write(join(site, "build/client/.feed.xml.gz"), "gzip");

		write(join(site, "build/client/assets/app-abc.js"), "app();");
		const before = Date.now();

		vercel().output?.({
			root: site,
			clientDirectory: join(site, "build/client"),
			entryFile: join(site, "build/server/app-server.js"),
			assetsPath: "/assets/",
			logger: quiet,
		});

		const client = join(site, ".vercel/output/functions/index.func/build/client");
		expect(filesUnder(client)).toStrictEqual([
			".app-server-files.json",
			".feed.xml.gz",
			"blog/.index.html.br",
			"feed.xml",
		]);
		const list = json(join(client, ".app-server-files.json")) as { builtAt: number };
		expect(list).toStrictEqual({
			builtAt: expect.any(Number),
			files: {
				"/.feed.xml.gz": "gzip".length,
				"/blog/.index.html.br": "br".length,
				"/feed.xml": "<rss/>".length,
			},
			brotliOnly: { "/blog/index.html": "<h1>Blog</h1>".length },
		});
		expect(list.builtAt).toBeGreaterThanOrEqual(before);
		expect(list.builtAt).toBeLessThanOrEqual(Date.now());
	});

	it("keeps each prerendered page in the function by default, with no start of the server build", () => {
		const site = mkdtempSync(join(tmpdir(), "app-server-vercel-default-pages-"));
		onTestFinished(() => {
			rmSync(site, { recursive: true, force: true });
		});
		// Why a throw: a server build whose plugins need the app's secrets fails when the build starts it.
		write(join(site, "build/server/app-server.js"), 'throw new Error("no DATABASE_URL");\n');
		write(join(site, "build/client/about/index.html"), "about");

		vercel().output?.({
			root: site,
			clientDirectory: join(site, "build/client"),
			entryFile: join(site, "build/server/app-server.js"),
			assetsPath: "/assets/",
			logger: quiet,
		});

		const siteOutput = join(site, ".vercel/output");
		expect(existsSync(join(siteOutput, "static"))).toBe(false);
		expect(filesUnder(join(siteOutput, "functions/index.func/build/client"))).toStrictEqual([
			".app-server-files.json",
			"about/index.html",
		]);
	});

	it("puts the files of Vite's build.assetsDir on the CDN with the immutable cache", () => {
		const custom = mkdtempSync(join(tmpdir(), "app-server-vercel-assets-dir-"));
		onTestFinished(() => {
			rmSync(custom, { recursive: true, force: true });
		});
		write(join(custom, "build/server/app-server.js"), entrySource());
		write(join(custom, "build/client/blog-assets/build/app-abc.js"), "app();");
		write(join(custom, "build/client/blog-assets/post.png"), "png");

		vercel({ cdnPaths: ["/blog-assets/"], cdnHeaders: { "Cache-Control": "max-age=60" } }).output?.(
			{
				root: custom,
				clientDirectory: join(custom, "build/client"),
				entryFile: join(custom, "build/server/app-server.js"),
				assetsPath: "/blog-assets/build/",
				logger: quiet,
			},
		);

		expect(filesUnder(join(custom, ".vercel/output/static"))).toStrictEqual([
			"blog-assets/build/app-abc.js",
			"blog-assets/post.png",
		]);
		// Why the order: the rule of `build.assetsDir` comes last, so its immutable cache wins.
		expect(json(join(custom, ".vercel/output/config.json"))).toMatchObject({
			routes: [
				{ handle: "filesystem" },
				{ src: "^/(.*)$", dest: "/index" },
				{ handle: "hit" },
				{ src: "^/blog-assets/.*$", headers: { "Cache-Control": "max-age=60" } },
				{
					src: String.raw`^/blog-assets/build/.*$`,
					headers: { "Cache-Control": "public, max-age=31536000, immutable" },
				},
			],
		});
	});

	it("serves each page that the server build marks from the CDN, with a route for each case and the twin's requests to the function", () => {
		const site = mkdtempSync(join(tmpdir(), "app-server-vercel-pages-"));
		onTestFinished(() => {
			rmSync(site, { recursive: true, force: true });
		});
		const page = (path: string, file: string, extra: object = {}) => ({
			path,
			cdn: {
				file,
				answers: [
					{ present: [], headers: { "x-robots-tag": "noindex, nofollow", vary: "x-ngrok-edge" } },
					{ present: ["x-ngrok-edge"], headers: { vary: "x-ngrok-edge" } },
				],
				...extra,
			},
		});
		write(
			join(site, "build/server/app-server.js"),
			entrySource([
				page("/about", "/about/index.html"),
				page("/docs", "/docs/index.html", { twin: "/docs.md" }),
				page("/docs.md", "/docs.md"),
				page("/drafts", "/drafts/index.html"),
				{ path: "/app", reason: "the status is 302" },
			]),
		);
		for (const file of [
			"about/index.html",
			"about/.index.html.br",
			"docs/index.html",
			"docs.md",
			"drafts/index.html",
			"app/index.html",
		]) {
			write(join(site, "build/client", file), file);
		}

		vercel({ cdnPages: (path) => path !== "/drafts" }).output?.({
			root: site,
			clientDirectory: join(site, "build/client"),
			entryFile: join(site, "build/server/app-server.js"),
			assetsPath: "/assets/",
			logger: quiet,
		});

		const siteOutput = join(site, ".vercel/output");
		expect(filesUnder(join(siteOutput, "static"))).toStrictEqual([
			"_app-server/pages/0/index.html",
			"_app-server/pages/1/index.html",
			"_app-server/pages/2/docs.md",
		]);
		expect(readFileSync(join(siteOutput, "static/_app-server/pages/0/index.html"), "utf8")).toBe(
			"CDN /about",
		);
		// Why each file: a request that no page route matches, such as `/about/`, reaches the function.
		expect(filesUnder(join(siteOutput, "functions/index.func/build/client"))).toStrictEqual([
			".app-server-files.json",
			"about/.index.html.br",
			"app/index.html",
			"docs.md",
			"docs/index.html",
			"drafts/index.html",
		]);
		const { routes } = json(join(siteOutput, "config.json")) as { routes: object[] };
		const accept = {
			type: "header",
			key: "accept",
			value: { re: "[tT][eE][xX][tT]/[mM][aA][rR][kK][dD][oO][wW][nN]" },
		};
		const edge = [{ type: "header", key: "x-ngrok-edge" }];
		const cases = (path: string, file: string) => [
			{
				src: `^${path.replaceAll(".", String.raw`\.`)}$`,
				caseSensitive: true,
				methods: ["GET", "HEAD"],
				missing: edge,
				headers: { "x-robots-tag": "noindex, nofollow", vary: "x-ngrok-edge" },
				dest: `/_app-server/pages${file}`,
			},
			{
				src: `^${path.replaceAll(".", String.raw`\.`)}$`,
				caseSensitive: true,
				methods: ["GET", "HEAD"],
				has: edge,
				headers: { vary: "x-ngrok-edge" },
				dest: `/_app-server/pages${file}`,
			},
		];
		expect(
			routes.slice(
				0,
				routes.findIndex((route) => "handle" in route),
			),
		).toStrictEqual([
			{ src: String.raw`^/_app-server/pages(?:/.*)?$`, dest: "/index" },
			...cases("/about", "/0/index.html"),
			{ src: "^/docs$", has: [accept], dest: "/index" },
			...cases("/docs", "/1/index.html"),
			...cases("/docs.md", "/2/docs.md"),
		]);
	});

	it("gives each page its own body when two paths have one file", () => {
		const site = mkdtempSync(join(tmpdir(), "app-server-vercel-shared-file-"));
		onTestFinished(() => {
			rmSync(site, { recursive: true, force: true });
		});
		const page = (path: string) => ({
			path,
			cdn: { file: "/about/index.html", answers: [{ present: [], headers: {} }] },
		});
		write(join(site, "build/server/app-server.js"), entrySource([page("/a"), page("/b")]));
		write(join(site, "build/client/about/index.html"), "about");

		vercel({ cdnPages: (path) => path !== "/a" }).output?.({
			root: site,
			clientDirectory: join(site, "build/client"),
			entryFile: join(site, "build/server/app-server.js"),
			assetsPath: "/assets/",
			logger: quiet,
		});

		const pages = join(site, ".vercel/output/static/_app-server/pages");
		expect(filesUnder(pages)).toStrictEqual(["1/index.html"]);
		expect(readFileSync(join(pages, "1/index.html"), "utf8")).toBe("CDN /b");
	});

	it("keeps a page in the function when `cdnPages` refuses its path before a trailing-slash redirect, or a header has a `$`", () => {
		const site = mkdtempSync(join(tmpdir(), "app-server-vercel-page-filter-"));
		onTestFinished(() => {
			rmSync(site, { recursive: true, force: true });
		});
		const page = (path: string, headers: Record<string, string> = {}) => ({
			path,
			cdn: { file: `${path}index.html`, answers: [{ present: [], headers }] },
		});
		write(
			join(site, "build/server/app-server.js"),
			entrySource([
				page("/blog/"),
				page("/files/", { "content-disposition": 'attachment; filename="$1.txt"' }),
				page("/about/"),
			]),
		);
		write(join(site, "build/client/about/index.html"), "about");

		vercel({ cdnPages: (path) => path !== "/blog" }).output?.({
			root: site,
			clientDirectory: join(site, "build/client"),
			entryFile: join(site, "build/server/app-server.js"),
			assetsPath: "/assets/",
			logger: quiet,
		});

		const { routes } = json(join(site, ".vercel/output/config.json")) as {
			routes: { src?: string }[];
		};
		expect(
			routes.map(({ src }) => src).filter((src) => src?.endsWith("/$") === true),
		).toStrictEqual(["^/about/$"]);
	});

	it("keeps the pages past Vercel's route limit in the function", () => {
		const site = mkdtempSync(join(tmpdir(), "app-server-vercel-route-limit-"));
		onTestFinished(() => {
			rmSync(site, { recursive: true, force: true });
		});
		const answers = [
			{ present: [], headers: {} },
			{ present: ["x-ngrok-edge"], headers: {} },
		];
		const paths = Array.from({ length: 1100 }, (_, index) => `/p${index}`);
		write(
			join(site, "build/server/app-server.js"),
			entrySource(paths.map((path) => ({ path, cdn: { file: `${path}/index.html`, answers } }))),
		);
		write(join(site, "build/client/p0/index.html"), "p0");

		vercel({ cdnPages: true }).output?.({
			root: site,
			clientDirectory: join(site, "build/client"),
			entryFile: join(site, "build/server/app-server.js"),
			assetsPath: "/assets/",
			logger: quiet,
		});

		const { routes } = json(join(site, ".vercel/output/config.json")) as {
			routes: { src?: string }[];
		};
		const served = new Set(
			routes.map(({ src }) => src).filter((src) => src?.startsWith("^/p") === true),
		);
		expect(routes.length).toBeLessThanOrEqual(2048);
		expect(served.size).toBeGreaterThan(1000);
		expect(served.has(`^/p${paths.length - 1}$`)).toBe(false);
		expect(filesUnder(join(site, ".vercel/output/static/_app-server/pages"))).toHaveLength(
			served.size,
		);
	});

	it("reports each path that the function serves, with its reason, through Vite's logger", () => {
		const site = mkdtempSync(join(tmpdir(), "app-server-vercel-report-"));
		onTestFinished(() => {
			rmSync(site, { recursive: true, force: true });
		});
		const kept = Array.from({ length: 25 }, (_, index) => ({
			path: `/account/${index}`,
			reason: "the status is 302",
		}));
		write(join(site, "build/server/app-server.js"), entrySource(kept));
		const logged: string[] = [];

		vercel({ cdnPages: true }).output?.({
			root: site,
			clientDirectory: join(site, "build/client"),
			entryFile: join(site, "build/server/app-server.js"),
			assetsPath: "/assets/",
			logger: {
				info: (message) => {
					logged.push(message);
				},
				warn: () => {},
			},
		});

		expect(logged).toStrictEqual([
			[
				"@ngrok/app-server/vercel: the CDN serves 0 prerendered paths, and the function serves 25.",
				...kept.map(({ path, reason }) => `  ${path}: ${reason}`),
			].join("\n"),
		]);
	});

	it("makes the build write only the copies that the output holds: brotli, and none for a CDN file", async () => {
		const site = mkdtempSync(join(tmpdir(), "app-server-vercel-copies-"));
		onTestFinished(() => {
			rmSync(site, { recursive: true, force: true });
		});
		const text = "Prerendered text for an agent.\n".repeat(50);
		write(join(site, "build/server/app-server.js"), entrySource());
		for (const file of ["assets/app-abc.js", "blog-assets/post.css", "about/index.html"]) {
			write(join(site, "build/client", file), text);
		}
		const [, postStep] = appServer({
			framework: reactRouterAdapter(),
			host: vercel({ cdnPaths: ["/blog-assets/"] }),
		});

		const buildApp = postStep?.buildApp;
		await (typeof buildApp === "object" ? buildApp.handler : buildApp)?.call(
			// Why the casts: the hook reads only these fields of `config`.
			{} as never,
			{
				config: {
					root: site,
					build: { outDir: "build/client", assetsDir: "assets" },
					environments: { ssr: { build: { outDir: "build/server" } } },
					logger: quiet,
				},
			} as never,
		);

		expect(filesUnder(join(site, "build/client"))).toStrictEqual([
			".app-server.json",
			"about/.index.html.br",
			"about/index.html",
			"assets/app-abc.js",
			"blog-assets/post.css",
		]);
		expect(
			filesUnder(join(site, ".vercel/output/functions/index.func/build/client")),
		).toStrictEqual([".app-server-files.json", ".app-server.json", "about/.index.html.br"]);
		expect(filesUnder(join(site, ".vercel/output/static"))).toStrictEqual([
			"assets/app-abc.js",
			"blog-assets/post.css",
		]);
	});

	it("fails the config for a CDN path that is not a URL path prefix", () => {
		expect(() => vercel({ cdnPaths: ["blog-assets"] })).toThrow(
			'Each cdnPaths entry is a URL path prefix that starts and ends with "/"',
		);
		expect(() => vercel({ cdnPaths: ["/"] })).toThrow("not");
	});
});
