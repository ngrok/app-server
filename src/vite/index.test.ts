import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { build as viteBuild, preview, resolveConfig } from "vite";
import type { InlineConfig, Plugin, ViteBuilder } from "vite";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { reactRouterAdapter } from "../react-router/vite.js";
import { node } from "../node/vite.js";
import { tanstackStartAdapter } from "../tanstack-start/vite.js";
import { SERVER_ENTRY_ID, appServer, serverEntrySource } from "./index.js";
import type { AppServerOptions } from "./index.js";

const root = mkdtempSync(join(tmpdir(), "app-server-vite-"));
mkdirSync(join(root, "build/client"), { recursive: true });

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("base64");
}

/** Answers like a framework's preview handler: one `writeHead` with every header. */
function responder(): Plugin {
	return {
		name: "responder",
		configurePreviewServer: (server) => () => {
			server.middlewares.use((request, response) => {
				const status = request.url === "/missing" ? 404 : 200;
				const headers = {
					"content-type":
						request.url === "/page" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
					"access-control-allow-origin": "*",
					"set-cookie": "session=1",
					"content-length": "2",
				};
				if (request.url === "/llms.txt") {
					// Why: TanStack Start's preview server sets the headers, then sends them again as a
					// flat array.
					response.setHeaders(new Map(Object.entries(headers)));
					response.writeHead(status, "", Object.entries(headers).flat());
				} else {
					response.writeHead(status, "", headers);
				}
				response.end("ok");
			});
		},
	};
}

/** A plugin with the name of a framework's plugin, so `appServer` finds that framework. */
function frameworkPlugin(name: string): Plugin {
	return { name };
}

/** The server entry that `appServer` generates in development for a project. */
async function serverEntry(
	options: AppServerOptions | undefined,
	{ plugins = [], projectRoot = root }: { plugins?: Plugin[]; projectRoot?: string } = {},
): Promise<string> {
	const [plugin] = appServer(options);
	await resolveConfig(
		{ root: projectRoot, configFile: false, logLevel: "silent", plugins: [...plugins, plugin] },
		"serve",
	);
	const load = plugin?.load;
	return String(
		Reflect.apply(
			(typeof load === "function" ? load : load?.handler) ?? (() => {}),
			{
				environment: { mode: "dev" },
			},
			[`\0${SERVER_ENTRY_ID}`],
		),
	);
}

describe("appServer with no options", () => {
	it("uses the React Router adapter and the node host when the config has the React Router plugin", async () => {
		const entry = await serverEntry(undefined, {
			plugins: [frameworkPlugin("react-router:virtual-modules")],
		});

		expect(entry).toContain('import("virtual:react-router/server-build"),');
		expect(entry).toContain('import("@ngrok/app-server/react-router"),');
		expect(entry).toContain('import("@ngrok/app-server/node"),');
	});

	it("uses the TanStack Start adapter when the config has the TanStack Start plugin", async () => {
		const entry = await serverEntry(undefined, {
			plugins: [frameworkPlugin("tanstack-react-start:config")],
		});

		expect(entry).toContain('import("virtual:tanstack-start-server-entry"),');
		expect(entry).toContain('import("@ngrok/app-server/tanstack-start"),');
	});

	it("fails for a config with no framework plugin, and says to pass `framework`", async () => {
		await expect(serverEntry(undefined)).rejects.toThrow(
			"found no React Router or TanStack Start plugin in the Vite config. Add the framework's plugin, or pass `framework` to `appServer`.",
		);
	});

	it("fails for a config with both framework plugins, and says to pass `framework`", async () => {
		await expect(
			serverEntry(undefined, {
				plugins: [
					frameworkPlugin("react-router:virtual-modules"),
					frameworkPlugin("tanstack-react-start:config"),
				],
			}),
		).rejects.toThrow("Pass `framework` to `appServer`.");
	});

	it("uses server.ts in the Vite root, else server.js, else the default app", async () => {
		// Why the real path: Vite resolves the root through symbolic links, such as `/tmp` on macOS.
		const project = realpathSync(mkdtempSync(join(tmpdir(), "app-server-vite-app-")));
		const plugins = [frameworkPlugin("react-router:virtual-modules")];

		await expect(serverEntry(undefined, { plugins, projectRoot: project })).resolves.toContain(
			"const app = createServer(",
		);
		writeFileSync(join(project, "server.js"), "");
		await expect(serverEntry(undefined, { plugins, projectRoot: project })).resolves.toContain(
			`import(${JSON.stringify(join(project, "server.js"))}),`,
		);
		writeFileSync(join(project, "server.ts"), "");
		await expect(serverEntry(undefined, { plugins, projectRoot: project })).resolves.toContain(
			`import(${JSON.stringify(join(project, "server.ts"))}),`,
		);
		rmSync(project, { recursive: true, force: true });
	});

	it("uses each option that the config gives over the detected value", async () => {
		const project = realpathSync(mkdtempSync(join(tmpdir(), "app-server-vite-explicit-")));
		writeFileSync(join(project, "server.ts"), "");

		const entry = await serverEntry(
			{
				framework: tanstackStartAdapter(),
				host: { name: "edge", runtimeModule: "edge-host", entryFileName: "edge.js" },
				app: "./src/app.ts",
			},
			{ plugins: [frameworkPlugin("react-router:virtual-modules")], projectRoot: project },
		);

		expect(entry).toContain('import("@ngrok/app-server/tanstack-start"),');
		expect(entry).toContain('import("edge-host"),');
		expect(entry).toContain(`import(${JSON.stringify(join(project, "src/app.ts"))}),`);
		rmSync(project, { recursive: true, force: true });
	});
});

describe("appServer", () => {
	it("records each 2xx path, and the headers of each that is not a document, with no cookie or length", async () => {
		vi.stubEnv("IS_RR_BUILD_REQUEST", "yes");
		mkdirSync(join(root, "build/client/page"), { recursive: true });
		writeFileSync(join(root, "build/client/page/index.html"), "<p>no scripts</p>");
		const server = await preview({
			root,
			configFile: false,
			appType: "custom",
			logLevel: "silent",
			plugins: [appServer({ framework: reactRouterAdapter(), host: node() }), responder()],
			build: { outDir: "build/client" },
			preview: { port: 0, host: "127.0.0.1" },
		});
		const base = server.resolvedUrls?.local[0] ?? "";

		await (await fetch(new URL("/llms.txt", base))).text();
		await (await fetch(new URL("/components/button/", base))).text();
		await (await fetch(new URL("/missing", base))).text();
		await (await fetch(new URL("/page", base))).text();
		await (await fetch(new URL("/caf%C3%A9.txt", base))).text();
		await server.close();

		expect(
			JSON.parse(readFileSync(join(root, "build/client/.app-server.json"), "utf8")),
		).toStrictEqual({
			prerendered: ["/café.txt", "/components/button", "/llms.txt", "/page"],
			headers: {
				"/café.txt": {
					"access-control-allow-origin": "*",
					"content-type": "text/plain; charset=utf-8",
				},
				"/components/button": {
					"access-control-allow-origin": "*",
					"content-type": "text/plain; charset=utf-8",
				},
				"/llms.txt": {
					"access-control-allow-origin": "*",
					"content-type": "text/plain; charset=utf-8",
				},
			},
			scriptHashes: { "/page/index.html": [] },
		});
	});

	it("records the hash of each inline script of each HTML file, once each, as the browser parses it", async () => {
		vi.stubEnv("IS_RR_BUILD_REQUEST", "yes");
		const theme = "document.documentElement.dataset.theme = 'dark';";
		const entry = 'import("/assets/entry.js");';
		const data = '{"a":1}';
		const boot = "boot();";
		const directory = mkdtempSync(join(tmpdir(), "app-server-vite-hashes-"));
		mkdirSync(join(directory, "build/client/docs"), { recursive: true });
		writeFileSync(
			join(directory, "build/client/docs/index.html"),
			[
				`<head><script nonce="baked">${theme}</script>`,
				'<script type="module" src="/assets/entry.js"></script>',
				`<SCRIPT type="module">${entry}</SCRIPT >`,
				`<script id="env" type="application/json">${data}</script></head>`,
				`<body><script nonce="baked">${theme}</script>`,
				// Why: the browser starts no element in a comment, and a `>` or `src=` in a value ends no tag.
				`<!-- <script> --><script data-note="a > b" data-x=" src=y">${boot}</script>`,
				// Why: the browser hashes each CRLF and CR as LF.
				"<script>\r\nfirst();\rsecond();\r\n</script></body>",
			].join(""),
		);
		writeFileSync(join(directory, "build/client/help.htm"), `<script>${boot}</script>`);
		const server = await preview({
			root: directory,
			configFile: false,
			appType: "custom",
			logLevel: "silent",
			plugins: [appServer({ framework: reactRouterAdapter(), host: node() }), responder()],
			build: { outDir: "build/client" },
			preview: { port: 0, host: "127.0.0.1" },
		});

		await (await fetch(new URL("/docs", server.resolvedUrls?.local[0]))).text();
		await server.close();

		expect(
			JSON.parse(readFileSync(join(directory, "build/client/.app-server.json"), "utf8")),
		).toMatchObject({
			scriptHashes: {
				"/docs/index.html": [theme, entry, data, boot, "\nfirst();\nsecond();\n"].map((text) =>
					sha256(text),
				),
				"/help.htm": [sha256(boot)],
			},
		});
		rmSync(directory, { recursive: true, force: true });
	});

	it("records the script hashes after a build with no prerender pass, and keeps the recorded paths", async () => {
		const client = join(root, "hash-build");
		mkdirSync(client, { recursive: true });
		writeFileSync(join(client, "offline.html"), "<script>retry();</script>");
		const builder = { config: { root, build: { outDir: "hash-build" }, environments: {} } };
		const [, gzipCopies] = appServer({ framework: reactRouterAdapter(), host: node() });
		const hook = gzipCopies?.buildApp;
		const buildApp = async () =>
			(typeof hook === "object" ? hook.handler : hook)?.call(
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only `config`.
				{} as never,
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only `config.root` and the output directories.
				builder as unknown as ViteBuilder,
			);
		const manifest = (): unknown =>
			JSON.parse(readFileSync(join(client, ".app-server.json"), "utf8"));

		await buildApp();
		expect(manifest()).toStrictEqual({
			prerendered: [],
			headers: {},
			scriptHashes: { "/offline.html": [sha256("retry();")] },
		});

		writeFileSync(
			join(client, ".app-server.json"),
			JSON.stringify({ prerendered: ["/"], headers: { "/x": {} }, scriptHashes: {} }),
		);
		await buildApp();
		expect(manifest()).toStrictEqual({
			prerendered: ["/"],
			headers: { "/x": {} },
			scriptHashes: { "/offline.html": [sha256("retry();")] },
		});
	});

	it("writes the gzip copy of each prerendered file after the pass, before the framework's plugin too", async () => {
		vi.stubEnv("IS_RR_BUILD_REQUEST", "yes");
		const text = "Prerendered text for an agent.\n".repeat(50);
		writeFileSync(join(root, "build/client/agents.txt"), text);
		const server = await preview({
			root,
			configFile: false,
			appType: "custom",
			logLevel: "silent",
			plugins: [appServer({ framework: reactRouterAdapter(), host: node() }), responder()],
			build: { outDir: "build/client" },
			preview: { port: 0, host: "127.0.0.1" },
		});

		await (await fetch(new URL("/agents.txt", server.resolvedUrls?.local[0]))).text();
		await server.close();

		expect(gunzipSync(readFileSync(join(root, "build/client/.agents.txt.gz"))).toString()).toBe(
			text,
		);
	});

	it("writes a build ID from the client bundle, which changes with its code and outlasts the prerender pass", async () => {
		vi.stubEnv("IS_RR_BUILD_REQUEST", "yes");
		const directory = mkdtempSync(join(tmpdir(), "app-server-vite-build-id-"));
		const client = join(directory, "build/client");
		const [main] = appServer({ framework: reactRouterAdapter(), host: node() });
		const hook = main?.writeBundle;
		const writeBundle = async (code: string) =>
			(typeof hook === "object" ? hook.handler : hook)?.call(
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only the environment's name and assets directory.
				{ environment: { name: "client", config: { build: { assetsDir: "assets" } } } } as never,
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only `dir`.
				{ dir: client } as never,
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only these fields.
				{ "assets/entry.js": { type: "chunk", fileName: "assets/entry.js", code } } as never,
			);
		const written = () =>
			JSON.parse(readFileSync(join(client, ".app-server.json"), "utf8")) as { buildId?: string };

		await writeBundle("render(1)");
		const first = written().buildId;
		await writeBundle("render(1)");
		const same = written().buildId;
		await writeBundle("render(2)");
		const changed = written().buildId;
		const server = await preview({
			root: directory,
			configFile: false,
			appType: "custom",
			logLevel: "silent",
			plugins: [appServer({ framework: reactRouterAdapter(), host: node() }), responder()],
			build: { outDir: "build/client" },
			preview: { port: 0, host: "127.0.0.1" },
		});
		await (await fetch(new URL("/llms.txt", server.resolvedUrls?.local[0]))).text();
		await server.close();

		expect(first).toMatch(/^[0-9a-f]{16}$/u);
		expect(same).toBe(first);
		expect(changed).not.toBe(first);
		expect(written()).toMatchObject({ buildId: changed, prerendered: ["/llms.txt"] });
		rmSync(directory, { recursive: true, force: true });
	});

	it("adds a file that the server build writes to the client's assets, such as React Router's route manifest, to the build ID", async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-server-vite-route-manifest-"));
		const client = join(directory, "build/client");
		const build = async (routeManifest: string | undefined) => {
			rmSync(client, { recursive: true, force: true });
			mkdirSync(join(client, "assets"), { recursive: true });
			writeFileSync(join(client, "assets/public-logo.svg"), "<svg/>");
			const [main, gzipCopies] = appServer({ framework: reactRouterAdapter(), host: node() });
			const writeBundle = main?.writeBundle;
			await (typeof writeBundle === "object" ? writeBundle.handler : writeBundle)?.call(
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only the environment's name and assets directory.
				{ environment: { name: "client", config: { build: { assetsDir: "assets" } } } } as never,
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only `dir`.
				{ dir: client } as never,
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only these fields.
				{
					"assets/entry.js": { type: "chunk", fileName: "assets/entry.js", code: "go()" },
				} as never,
			);
			if (routeManifest != null) {
				writeFileSync(join(client, "assets/manifest-1.js"), routeManifest);
			}
			const buildApp = gzipCopies?.buildApp;
			await (typeof buildApp === "object" ? buildApp.handler : buildApp)?.call(
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only `config`.
				{} as never,
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only `config.root` and the output directories.
				{
					config: { root: directory, build: { outDir: "build/client" }, environments: {} },
				} as never,
			);
			const manifest = JSON.parse(readFileSync(join(client, ".app-server.json"), "utf8")) as {
				buildId?: string;
			};
			return manifest.buildId;
		};

		const bundleOnly = await build(undefined);
		const routes = await build('window.__reactRouterManifest={"routes":{"about":"/about"}}');
		const sameRoutes = await build('window.__reactRouterManifest={"routes":{"about":"/about"}}');
		const movedRoute = await build('window.__reactRouterManifest={"routes":{"about":"/info"}}');

		expect(bundleOnly).toMatch(/^[0-9a-f]{16}$/u);
		expect(routes).not.toBe(bundleOnly);
		expect(sameRoutes).toBe(routes);
		expect(movedRoute).not.toBe(routes);
		rmSync(directory, { recursive: true, force: true });
	});

	it("records nothing outside the framework's prerender pass", async () => {
		const outside = mkdtempSync(join(tmpdir(), "app-server-vite-outside-"));
		const server = await preview({
			root: outside,
			configFile: false,
			appType: "custom",
			logLevel: "silent",
			plugins: [appServer({ framework: reactRouterAdapter(), host: node() }), responder()],
			build: { outDir: "build/client" },
			preview: { port: 0, host: "127.0.0.1" },
		});

		await (await fetch(new URL("/llms.txt", server.resolvedUrls?.local[0]))).text();
		await server.close();

		expect(existsSync(join(outside, "build/client/.app-server.json"))).toBe(false);
		rmSync(outside, { recursive: true, force: true });
	});

	it("generates an entry that the bundle's copy of the package makes from the adapters", () => {
		expect(
			serverEntrySource({
				framework: reactRouterAdapter(),
				host: node(),
				appModule: "/app/server.ts",
				clientDirectory: "CLIENT",
			}),
		).toBe(
			[
				"if (import.meta.main) {",
				'\tprocess.env.NODE_ENV ??= "production";',
				'\tif (typeof process.setSourceMapsEnabled === "function") {',
				"\t\tprocess.setSourceMapsEnabled(true);",
				"\t}",
				"}",
				"const [serverModule, { createEntry, createServer }, { runtime }, { host }, { default: app }] = await Promise.all([",
				'\timport("virtual:react-router/server-build"),',
				'\timport("@ngrok/app-server"),',
				'\timport("@ngrok/app-server/react-router"),',
				'\timport("@ngrok/app-server/node"),',
				'\timport("/app/server.ts"),',
				"]);",
				"export const appServer = createEntry({",
				"\tapp,",
				"\thost,",
				"\tclientDirectory: CLIENT,",
				"\tframework: (mode) => runtime(serverModule, { mode }),",
				"});",
				"if (import.meta.main) {",
				"\tawait appServer.start();",
				"}",
			].join("\n"),
		);
	});

	it("passes the framework's runtime options to its runtime", () => {
		expect(
			serverEntrySource({
				framework: { ...reactRouterAdapter(), runtimeOptions: "{ serverFnBase: BASE }" },
				host: node(),
				appModule: undefined,
				clientDirectory: "CLIENT",
			}),
		).toContain("framework: (mode) => runtime(serverModule, { ...{ serverFnBase: BASE }, mode }),");
	});

	it("fails the build for a server build inside the client build, so no one can fetch its code", () => {
		const [plugin] = appServer({ framework: reactRouterAdapter(), host: node() });
		const configResolved = plugin?.configResolved;
		const load = plugin?.load;
		const build = (outDir: string) => ({ build: { outDir } });
		Reflect.apply(
			(typeof configResolved === "function" ? configResolved : configResolved?.handler) ??
				(() => {}),
			{},
			[
				{
					root,
					base: "/",
					build: { outDir: "build" },
					environments: { client: build("build"), ssr: build("build/server") },
				},
			],
		);

		const loadEntry = (mode: string): void => {
			Reflect.apply(
				(typeof load === "function" ? load : load?.handler) ?? (() => {}),
				{ environment: { mode } },
				[`\0${SERVER_ENTRY_ID}`],
			);
		};

		expect(() => {
			loadEntry("build");
		}).toThrow("needs the server build outside the client build");
		// Why: development serves no build directory, so a config can share one there.
		expect(() => {
			loadEntry("dev");
		}).not.toThrow();
	});

	it("fails the build for a server build that is not an ES module", () => {
		const [plugin] = appServer({ framework: reactRouterAdapter(), host: node() });
		const renderStart = plugin?.renderStart;
		const handler = typeof renderStart === "function" ? renderStart : renderStart?.handler;

		expect(() => {
			Reflect.apply(handler ?? (() => {}), { environment: { name: "ssr" } }, [
				{ format: "cjs" },
				{},
			]);
		}).toThrow('needs an ES module server build, and this build has the format "cjs"');
	});

	it("fails the build for a base other than /", async () => {
		await expect(
			preview({
				root,
				configFile: false,
				base: "/docs/",
				logLevel: "silent",
				plugins: [appServer({ framework: reactRouterAdapter(), host: node() })],
				preview: { port: 0, host: "127.0.0.1" },
			}),
		).rejects.toThrow('serves a build at "/" only, and this config has the base "/docs/"');
	});

	it("writes a gzip copy of each text file of 1 KiB or more after the build, except HTML", async () => {
		const client = join(root, "gzip-build");
		const text = "export const value = 1;\n".repeat(100);
		const files: Record<string, string | Uint8Array> = {
			"assets/app-abc.js": text,
			"docs/llms.txt": text,
			"index.html": `<p>${text}</p>`,
			"small.txt": "small",
			// Why: a copy from an earlier build of a file that is now too small.
			".small.txt.gz": "stale",
			"photo.png": text,
			"release.tar": text,
			"release.tar.gz": "archive",
			"data.json": "{}",
			"data.json.gz": "app data",
			".app-server.json": JSON.stringify({ prerendered: [text] }),
		};
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(client, path)), { recursive: true });
			writeFileSync(join(client, path), content);
		}
		const [, gzipCopies] = appServer({ framework: reactRouterAdapter(), host: node() });
		const hook = gzipCopies?.buildApp;
		const builder = {
			config: {
				root,
				build: { outDir: "build/client" },
				environments: { client: { build: { outDir: "gzip-build" } } },
			},
		};

		await (typeof hook === "object" ? hook.handler : hook)?.call(
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only `config`.
			{} as never,
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only `config.root` and the output directories.
			builder as unknown as ViteBuilder,
		);

		const copy = (path: string) => join(client, dirname(path), `.${basename(path)}.gz`);
		for (const path of ["assets/app-abc.js", "docs/llms.txt"]) {
			expect(gunzipSync(readFileSync(copy(path))).toString()).toBe(text);
		}
		for (const path of [
			"index.html",
			"small.txt",
			"photo.png",
			"release.tar",
			".app-server.json",
		]) {
			expect(existsSync(copy(path))).toBe(false);
		}
		expect(readFileSync(join(client, "release.tar.gz"), "utf8")).toBe("archive");
		expect(readFileSync(join(client, "data.json.gz"), "utf8")).toBe("app data");
	});
});

describe("appServer in a server build", () => {
	/** The plugin of `appServer` that makes the server build run with no install. */
	const standalonePlugin = () =>
		appServer({ framework: reactRouterAdapter(), host: node() }).find(
			(plugin) => plugin.name === "@ngrok/app-server:standalone",
		);

	/** Writes files under `directory`. */
	function writeFiles(directory: string, files: Record<string, string>): void {
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(directory, path)), { recursive: true });
			writeFileSync(join(directory, path), content);
		}
	}

	/**
	 * Builds `entry.js` of a project with `files` and the Vite `config`, copies
	 * the build alone to a new directory, and gives the `values` export of the
	 * copy, and the path of the copied server build.
	 */
	async function buildAlone(
		files: Record<string, string>,
		config: InlineConfig,
	): Promise<{ values: unknown; server: string }> {
		const project = realpathSync(mkdtempSync(join(tmpdir(), "app-server-vite-standalone-")));
		const deployed = realpathSync(mkdtempSync(join(tmpdir(), "app-server-vite-deployed-")));
		onTestFinished(() => {
			rmSync(project, { recursive: true, force: true });
			rmSync(deployed, { recursive: true, force: true });
		});
		writeFiles(project, { "package.json": JSON.stringify({ type: "module" }), ...files });
		await viteBuild({
			root: project,
			configFile: false,
			logLevel: "silent",
			plugins: [standalonePlugin()],
			...config,
			build: { ssr: "entry.js", outDir: "build/server", ...config.build },
		});
		// Why a copy: no `node_modules` is above the temporary directory, so the build must hold each package.
		cpSync(join(project, "build"), join(deployed, "build"), { recursive: true });
		const url = pathToFileURL(join(deployed, "build/server/entry.js")).href;
		const output = execFileSync(
			process.execPath,
			["--input-type=module", "-e", `console.log(JSON.stringify((await import("${url}")).values))`],
			{ encoding: "utf8" },
		);
		return { values: JSON.parse(output), server: join(deployed, "build/server") };
	}

	/** A package in `node_modules` with `main` at `index.js`. */
	const commonJsPackage = (
		name: string,
		source: string,
		manifest: Record<string, unknown> = {},
	): Record<string, string> => ({
		[`node_modules/${name}/package.json`]: JSON.stringify({ name, main: "index.js", ...manifest }),
		[`node_modules/${name}/index.js`]: source,
	});

	it("bundles each dependency, and copies each native or external package next to the build", async () => {
		const { values, server } = await buildAlone(
			{
				"entry.js": [
					'import { pure } from "pure";',
					'import { native } from "native";',
					'import { kept } from "kept";',
					"export const values = [pure, native, kept];",
				].join("\n"),
				...commonJsPackage("pure", 'exports.pure = "pure";'),
				// Why `__dirname`: a native package loads its addon from a path next to its own code.
				...commonJsPackage(
					"native",
					[
						'const { readFileSync } = require("node:fs");',
						'exports.native = readFileSync(__dirname + "/build/Release/native.node", "utf8");',
					].join("\n"),
				),
				"node_modules/native/build/Release/native.node": "native",
				...commonJsPackage(
					"kept",
					[
						'const { readFileSync } = require("node:fs");',
						'exports.kept = readFileSync(__dirname + "/word.txt", "utf8") + require("helper");',
					].join("\n"),
					{ dependencies: { helper: "1.0.0" } },
				),
				"node_modules/kept/word.txt": "kept with ",
				...commonJsPackage("helper", 'module.exports = "helper";'),
			},
			{ ssr: { external: ["kept"] } },
		);

		expect(values).toStrictEqual(["pure", "native", "kept with helper"]);
		expect(readFileSync(join(server, "entry.js"), "utf8")).toContain('"pure"');
		expect(existsSync(join(server, "node_modules/pure"))).toBe(false);
	});

	it.each([
		{ ssr: { external: ["widget"] } },
		{ ssr: { external: ["widget/server"] } },
		{ build: { rolldownOptions: { external: ["widget/server"] } } },
	])(
		"gives the bundle and an external package one copy of each shared package: %j",
		async (config) => {
			const { values } = await buildAlone(
				{
					"entry.js": [
						'import { token } from "shared";',
						'import { registry } from "widget";',
						'import { sameToken, sameRegistry } from "widget/server";',
						"export const values = [sameToken(token), sameRegistry(registry)];",
					].join("\n"),
					...commonJsPackage("shared", "exports.token = {};"),
					// Why a peer two levels down: `widget` gets `shared` through the peer of its peer.
					...commonJsPackage("middle", 'exports.token = require("shared").token;', {
						peerDependencies: { shared: "1.0.0" },
					}),
					...commonJsPackage("widget", "exports.registry = {};", {
						exports: { ".": "./index.js", "./server": "./server.js" },
						peerDependencies: { middle: "1.0.0" },
					}),
					"node_modules/widget/server.js": [
						'exports.sameToken = (token) => token === require("middle").token;',
						'exports.sameRegistry = (registry) => registry === require("./index.js").registry;',
					].join("\n"),
				},
				config,
			);

			expect(values).toStrictEqual([true, true]);
		},
	);

	it("bundles a JSON file or an asset of a native package", async () => {
		const { values } = await buildAlone(
			{
				"entry.js": [
					'import manifest from "native/package.json";',
					'import notes from "native/notes.txt?raw";',
					'import license from "native/LICENSE?raw";',
					"export const values = [manifest.name, notes, license];",
				].join("\n"),
				...commonJsPackage("native", ""),
				"node_modules/native/addon.node": "",
				"node_modules/native/notes.txt": "notes",
				"node_modules/native/LICENSE": "License text",
			},
			{},
		);

		expect(values).toStrictEqual(["native", "notes", "License text"]);
	});

	it("copies a package that the bundler's own `external` option keeps external", async () => {
		const { values } = await buildAlone(
			{
				"entry.js": 'import { word } from "wrapper";\nexport const values = [word];',
				"node_modules/wrapper/package.json": JSON.stringify({ name: "wrapper", type: "module" }),
				"node_modules/wrapper/index.js": 'export { word } from "outside";',
				// Why only in `wrapper`: with pnpm, a dependency of a dependency is not at the top.
				...commonJsPackage("wrapper/node_modules/outside", 'exports.word = "outside";'),
			},
			{ build: { rolldownOptions: { external: ["outside"] } } },
		);

		expect(values).toStrictEqual(["outside"]);
	});

	it("copies the native package that Vite resolves, such as for `resolve.dedupe`", async () => {
		const nativePackage = (directory: string, version: string) => ({
			...commonJsPackage(
				directory,
				`exports.version = require("node:fs").readFileSync(__dirname + "/addon.node", "utf8");`,
				{ version },
			),
			[`node_modules/${directory}/addon.node`]: version,
		});
		const { values } = await buildAlone(
			{
				"entry.js": 'import { version } from "wrapper";\nexport const values = [version];',
				...commonJsPackage("wrapper", 'exports.version = require("native").version;'),
				...nativePackage("native", "2.0.0"),
				...nativePackage("wrapper/node_modules/native", "1.0.0"),
			},
			{ resolve: { dedupe: ["native"] } },
		);

		expect(values).toStrictEqual(["2.0.0"]);
	});

	it("bundles each dependency in a build, unless the app sets its own `ssr.noExternal` or `ssr.external: true`", async () => {
		const resolve = async (
			ssr: { noExternal?: string[]; external?: true },
			command: "build" | "serve",
		) =>
			(
				await resolveConfig(
					{ root, configFile: false, logLevel: "silent", plugins: [standalonePlugin()], ssr },
					command,
				)
			).ssr.noExternal;

		await expect(resolve({}, "build")).resolves.toBe(true);
		await expect(resolve({ noExternal: ["only-this"] }, "build")).resolves.toStrictEqual([
			"only-this",
		]);
		await expect(resolve({}, "serve")).resolves.toStrictEqual([]);
		await expect(resolve({ external: true }, "build")).resolves.toStrictEqual([]);
	});
});
