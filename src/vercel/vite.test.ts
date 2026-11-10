import {
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
import { vercel } from "./vite.js";

const root = mkdtempSync(join(tmpdir(), "app-server-vercel-"));
const clientDirectory = join(root, "build/client");
const entryFile = join(root, "build/server/app-server.js");
const output = join(root, ".vercel/output");
const functionDirectory = join(output, "functions/index.func");

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

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

		host.output?.({ root, clientDirectory, entryFile, assetsPath: "/assets/" });

		expect(filesUnder(output)).toStrictEqual([
			"config.json",
			"functions/index.func/.vc-config.json",
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
			environment: { APP_SERVER_BUILT_AT: expect.stringMatching(/^\d+$/u) },
			regions: ["iad1"],
		});
		expect(json(join(output, "config.json"))).toStrictEqual({
			version: 3,
			routes: [
				{ handle: "filesystem" },
				{ src: "^/(.*)$", dest: "/index" },
				{ handle: "hit" },
				{
					src: "^/assets/.*$",
					headers: {
						"Access-Control-Allow-Origin": "*",
						"Cache-Control": "public, max-age=31536000, immutable",
					},
					continue: true,
				},
				{
					src: "^/blog-assets/.*$",
					headers: { "Access-Control-Allow-Origin": "*" },
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
		});

		expect(filesUnder(join(nested, ".vercel/output/functions/index.func/dist"))).toStrictEqual([
			"app-server.js",
			"client/robots.txt",
			"vercel-function.js",
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

		vercel().output?.({
			root: custom,
			clientDirectory: join(custom, "build/client"),
			entryFile: join(custom, "build/server/app-server.js"),
			assetsPath: "/blog-assets/build/",
		});

		expect(filesUnder(join(custom, ".vercel/output/static"))).toStrictEqual([
			"blog-assets/build/app-abc.js",
		]);
		expect(json(join(custom, ".vercel/output/config.json"))).toMatchObject({
			routes: [
				{ handle: "filesystem" },
				{ src: "^/(.*)$", dest: "/index" },
				{ handle: "hit" },
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
		});

		const siteOutput = join(site, ".vercel/output");
		expect(filesUnder(join(siteOutput, "static"))).toStrictEqual([
			"_app-server/pages/about/index.html",
			"_app-server/pages/docs.md",
			"_app-server/pages/docs/index.html",
		]);
		expect(
			readFileSync(join(siteOutput, "static/_app-server/pages/about/index.html"), "utf8"),
		).toBe("CDN /about");
		expect(filesUnder(join(siteOutput, "functions/index.func/build/client"))).toStrictEqual([
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
			...cases("/about", "/about/index.html"),
			{ src: "^/docs$", has: [accept], dest: "/index" },
			...cases("/docs", "/docs/index.html"),
			...cases("/docs.md", "/docs.md"),
		]);
	});

	it("fails the config for a CDN path that is not a URL path prefix", () => {
		expect(() => vercel({ cdnPaths: ["blog-assets"] })).toThrow(
			'Each cdnPaths entry is a URL path prefix that starts and ends with "/"',
		);
		expect(() => vercel({ cdnPaths: ["/"] })).toThrow("not");
	});
});
