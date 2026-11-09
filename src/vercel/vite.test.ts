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
write(entryFile, `import "./chunk.js";\nexport const appServer = {};\n`);
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
		write(join(nested, "dist/app-server.js"), "export const appServer = {};\n");
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
		write(join(custom, "build/server/app-server.js"), "export const appServer = {};\n");
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

	it("fails the config for a CDN path that is not a URL path prefix", () => {
		expect(() => vercel({ cdnPaths: ["blog-assets"] })).toThrow(
			'Each cdnPaths entry is a URL path prefix that starts and ends with "/"',
		);
		expect(() => vercel({ cdnPaths: ["/"] })).toThrow("not");
	});
});
