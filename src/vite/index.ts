import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { constants, gzipSync } from "node:zlib";
import { getPath } from "hono/utils/url";
import type { Plugin, PreviewServer, ResolvedConfig } from "vite";
import { BUILD_MANIFEST_FILE, manifestKey } from "../core/build-manifest.js";
import type { BuildManifest } from "../core/build-manifest.js";
import { gzipCopyName, isCompressible, MIN_GZIP_BYTES } from "../core/gzip-rules.js";
import { contentType } from "../core/static-files.js";

/** The module ID of the server entry that {@link appServer} generates. */
export const SERVER_ENTRY_ID = "virtual:@ngrok/app-server/entry";
const RESOLVED_SERVER_ENTRY_ID = `\0${SERVER_ENTRY_ID}`;

/** The Vite environment that builds the server. */
const SERVER_ENVIRONMENT = "ssr";

/** The header that turns on Node's header store for a response, so `finish` can read every header. */
const CAPTURE_MARKER = "x-app-server-capture";

/**
 * Headers that describe one transfer, not the resource. The server sets its
 * own, and a cookie must never replay to every visitor. `Vary` is left out
 * because the preview server adds `Vary: Origin` to every response.
 */
const UNCAPTURED_HEADERS = new Set([
	CAPTURE_MARKER,
	"connection",
	"content-encoding",
	"content-length",
	"date",
	"etag",
	"keep-alive",
	"last-modified",
	"set-cookie",
	"transfer-encoding",
	"vary",
]);

/**
 * The build side of a framework adapter. The Vite config imports it, such as
 * `reactRouterAdapter()` from `@ngrok/app-server/react-router/vite`.
 */
export type FrameworkBuild = {
	/** A name for logs and errors. */
	name: string;
	/** The Vite ID of the framework's server module, such as `virtual:react-router/server-build`. */
	serverModule: string;
	/**
	 * The module whose `runtime` export makes the run side from the server
	 * module. It has the type `FrameworkRuntimeFactory`.
	 */
	runtimeModule: string;
	/**
	 * The source of an object literal with more options for `runtime`, such as
	 * a build constant of the framework. The bundler replaces the constants in
	 * it, because the source is part of the server entry.
	 */
	runtimeOptions?: string;
	/** Whether a preview server runs the framework's prerender pass. */
	isPrerenderPass: (server: PreviewServer) => boolean;
	/** Throws for a config that the adapter does not support, so the build fails, not the first request. */
	validate?: (config: ResolvedConfig) => void;
};

/**
 * The build side of a host adapter. The Vite config imports it, such as
 * `node()` from `@ngrok/app-server/node/vite`.
 */
export type HostBuild = {
	/** A name for logs and errors. */
	name: string;
	/** The module whose `host` export is the run side, a `HostRuntime`. */
	runtimeModule: string;
	/** The file name of the server entry in the server build, such as `app-server.js`. */
	entryFileName: string;
};

/** Options for {@link appServer}. */
export type AppServerOptions = {
	framework: FrameworkBuild;
	host: HostBuild;
	/**
	 * The module whose default export is the app from `createServer`, relative
	 * to the Vite root. When omitted, the server uses its default plugins.
	 */
	app?: string;
};

/** What {@link serverEntrySource} needs. */
type EntrySource = {
	framework: Pick<FrameworkBuild, "serverModule" | "runtimeModule" | "runtimeOptions">;
	host: Pick<HostBuild, "runtimeModule">;
	/** The absolute path of the app module, else `undefined` for the default app. */
	appModule: string | undefined;
	/** The source of an expression that gives the client build: a path or a `file:` URL. */
	clientDirectory: string;
};

/** The source of the server entry. */
export function serverEntrySource({
	framework,
	host,
	appModule,
	clientDirectory,
}: EntrySource): string {
	return [
		`import * as serverModule from ${JSON.stringify(framework.serverModule)};`,
		// Why from the bundle: the CLI calls this export, so the server runs on the bundle's copy of
		// this package and of the framework, the same copies as the app and the routes.
		`import { createEntry, createServer } from "@ngrok/app-server";`,
		`import { runtime } from ${JSON.stringify(framework.runtimeModule)};`,
		`import { host } from ${JSON.stringify(host.runtimeModule)};`,
		...(appModule == null
			? [
					`const app = createServer({ trustForwardedProto: process.env.TRUST_FORWARDED_PROTO === "1", trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? 0) });`,
				]
			: [`import app from ${JSON.stringify(appModule)};`]),
		`export const appServer = createEntry({`,
		`\tapp,`,
		`\thost,`,
		`\tclientDirectory: ${clientDirectory},`,
		`\tframework: (mode) => runtime(serverModule, { ${framework.runtimeOptions == null ? "" : `...${framework.runtimeOptions}, `}mode }),`,
		`});`,
	].join("\n");
}

/** The absolute path of an environment's build output. */
function outDir(config: ResolvedConfig, environment: string): string {
	return resolve(
		config.root,
		config.environments[environment]?.build.outDir ?? config.build.outDir,
	);
}

/**
 * An HTML comment, or a `<script>` element. The `attributes` group is the
 * script's attributes, and the `text` group is its text. Why the comment: a
 * `<script>` tag in a comment starts no element.
 */
const COMMENT_OR_SCRIPT =
	/<!--[\s\S]*?-->|<script(?=[\s/>])(?<attributes>(?:[^>"']|"[^"]*"|'[^']*')*)>(?<text>[\s\S]*?)<\/script(?=[\s/>])/giu;

/** An attribute value, so that a `src=` in a value is not the `src` attribute. */
const ATTRIBUTE_VALUE = /[=]\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gu;

/** A `src` attribute, in attributes with no values. */
const SRC_ATTRIBUTE = /(?:^|[\s/])src(?:[\s/=]|$)/iu;

/**
 * The base64 SHA-256 of each inline script in `html`, once each, in
 * document order. Why each type: a hash of a data block, such as JSON, trusts
 * no code, and a scan that skips a type that runs breaks the page. Why LF:
 * the browser changes each CRLF and CR to LF before it hashes a script.
 *
 * @example
 * inlineScriptHashes("<script>go()</script>"); // => ["…base64…"]
 */
function inlineScriptHashes(html: string): string[] {
	const hashes: string[] = [];
	for (const { groups } of html.replaceAll(/\r\n?/gu, "\n").matchAll(COMMENT_OR_SCRIPT)) {
		if (
			groups?.text != null &&
			!SRC_ATTRIBUTE.test((groups.attributes ?? "").replaceAll(ATTRIBUTE_VALUE, "="))
		) {
			hashes.push(createHash("sha256").update(groups.text).digest("base64"));
		}
	}
	return [...new Set(hashes)];
}

/** The {@link inlineScriptHashes} of each HTML file in the client build, by its URL path. */
function scriptHashesOf(clientDirectory: string): BuildManifest["scriptHashes"] {
	const hashes: BuildManifest["scriptHashes"] = {};
	for (const entry of readdirSync(clientDirectory, { recursive: true, withFileTypes: true })) {
		// Why `contentType`: the static stages send each file of an HTML type, such as `.htm`, as a document.
		if (entry.isFile() && contentType(entry.name, {}).startsWith("text/html")) {
			const path = join(entry.parentPath, entry.name);
			const urlPath = `/${relative(clientDirectory, path).split(sep).join("/")}`;
			hashes[urlPath] = inlineScriptHashes(readFileSync(path, "utf8"));
		}
	}
	return Object.fromEntries(
		Object.entries(hashes).toSorted(([first], [second]) => first.localeCompare(second)),
	);
}

/** Writes `.app-server.json` into the client build. */
function writeBuildManifest(clientDirectory: string, manifest: BuildManifest): void {
	writeFileSync(
		join(clientDirectory, BUILD_MANIFEST_FILE),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
}

/**
 * Writes the script hashes of the client build ({@link scriptHashesOf}) into
 * `.app-server.json`, and keeps the rest of the file. Why after the build
 * too: a build with no prerender pass can have HTML files, such as
 * `public/offline.html`.
 */
function recordScriptHashes(clientDirectory: string): void {
	if (!existsSync(clientDirectory)) {
		return;
	}
	const path = join(clientDirectory, BUILD_MANIFEST_FILE);
	const recorded: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
	writeBuildManifest(clientDirectory, {
		prerendered: [],
		headers: {},
		...(typeof recorded === "object" && recorded != null ? recorded : {}),
		scriptHashes: scriptHashesOf(clientDirectory),
	});
}

/**
 * Records each 2xx path and the headers of each non-document response while
 * the framework's prerender pass runs. It writes them to `.app-server.json` in
 * the client build when the preview server closes, with the script hashes of
 * each HTML file.
 */
function capture(server: PreviewServer): void {
	const clientDirectory = outDir(server.config, "client");
	const paths = new Set<string>();
	const headers: BuildManifest["headers"] = {};
	server.middlewares.use((request, response, next) => {
		// Why `getPath`: the static stages look a file up by Hono's decoded path, such as `/café.json`.
		const pathname = getPath(new Request(new URL(request.url ?? "/", "http://localhost")));
		// Why: Node keeps the headers that `writeHead` gets readable only when a header was set first.
		response.setHeader(CAPTURE_MARKER, "1");
		response.once("finish", () => {
			if (response.statusCode < 200 || response.statusCode >= 300) {
				return;
			}
			const key = manifestKey(pathname);
			paths.add(key);
			// Why skip documents: the framework sets their headers for each request (a nonce, the
			// host), so the headers of the build's request are wrong for every other one.
			if (String(response.getHeader("content-type") ?? "").startsWith("text/html")) {
				return;
			}
			const recorded: Record<string, string> = {};
			for (const [name, value] of Object.entries(response.getHeaders())) {
				// Why skip index names: after a `setHeader`, Node stores a flat header array from
				// `writeHead`, as TanStack Start's preview server sends, under its indexes too.
				if (!UNCAPTURED_HEADERS.has(name) && !/^\d+$/u.test(name) && value != null) {
					recorded[name] = Array.isArray(value) ? value.join(", ") : String(value);
				}
			}
			headers[key] = recorded;
		});
		next();
	});
	server.httpServer.once("close", () => {
		mkdirSync(clientDirectory, { recursive: true });
		writeBuildManifest(clientDirectory, {
			prerendered: [...paths].toSorted(),
			headers: Object.fromEntries(
				Object.entries(headers).toSorted(([first], [second]) => first.localeCompare(second)),
			),
			scriptHashes: scriptHashesOf(clientDirectory),
		});
		// Why here too: the gzip step of `buildApp` runs before this pass when `appServer` comes
		// before the framework's plugin. Why sync: Vite does not wait for this listener.
		for (const path of paths) {
			writeGzipCopy(join(clientDirectory, path));
		}
	});
}

/**
 * Writes a gzip copy (`.<file>.gz`) next to the file at `path` when the
 * server gzips the file: a compressible type that is not HTML, of 1 KiB or
 * more, whose copy is smaller. Else it removes an old copy, so a copy from an
 * earlier build never replaces a changed file.
 */
function writeGzipCopy(path: string): void {
	const copyPath = join(dirname(path), gzipCopyName(basename(path)));
	const type = contentType(path, {});
	const bytes =
		isCompressible(type) &&
		!type.startsWith("text/html") &&
		statSync(path, { throwIfNoEntry: false })?.isFile() === true
			? readFileSync(path)
			: undefined;
	// Why the highest level: the build gzips each file once, and each response sends fewer bytes.
	const copy =
		bytes == null || bytes.byteLength < MIN_GZIP_BYTES
			? undefined
			: gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION });
	if (copy == null || bytes == null || copy.byteLength >= bytes.byteLength) {
		rmSync(copyPath, { force: true });
		return;
	}
	writeFileSync(copyPath, copy);
}

/** Runs {@link writeGzipCopy} for each file in the client build, except dotfiles such as the copies. */
function writeGzipCopies(clientDirectory: string): void {
	if (!existsSync(clientDirectory)) {
		return;
	}
	for (const entry of readdirSync(clientDirectory, { recursive: true, withFileTypes: true })) {
		// Why skip dotfiles: the server never sends one, such as `.app-server.json`.
		if (entry.isFile() && !entry.name.startsWith(".")) {
			writeGzipCopy(join(entry.parentPath, entry.name));
		}
	}
}

/**
 * The Vite plugin for `@ngrok/app-server`. Put it next to the framework's
 * plugin.
 *
 * - It adds the server entry to the server build, such as
 *   `build/server/app-server.js` on the node host. The entry bundles the app
 *   (the default export of `app`) with the framework's server module, so the
 *   server gets the app's path aliases and its one copy of the framework.
 *   The framework's own entry does not change.
 * - During the framework's prerender pass, it records each prerendered path
 *   and the headers of each prerendered file that is not an HTML document into
 *   `.app-server.json` in the client build. The `prerendered` plugin replays
 *   the headers. A document's headers depend on its request, so they are not
 *   recorded.
 * - After the build and after the prerender pass, it records the hash of each
 *   inline script of each HTML file in `.app-server.json`, for the
 *   `contentSecurityPolicy` plugin. It also writes a gzip copy
 *   (`.<file>.gz`) next to each text file of 1 KiB or more in the client
 *   build, except HTML. The static stages send the copy, so the server does
 *   not gzip these files for each request.
 *
 * @example
 * // vite.config.ts
 * export default defineConfig({
 * 	plugins: [
 * 		reactRouter(),
 * 		appServer({ framework: reactRouterAdapter(), host: node(), app: "./server.ts" }),
 * 	],
 * });
 */
export function appServer({ framework, host, app }: AppServerOptions): Plugin[] {
	let config: ResolvedConfig | undefined;
	const gzipCopies: Plugin = {
		name: "@ngrok/app-server:gzip-copies",
		// Why last: the framework prerenders in a `buildApp` hook of an `enforce: "post"` plugin.
		enforce: "post",
		buildApp: {
			order: "post",
			handler: async (builder) => {
				const clientDirectory = outDir(builder.config, "client");
				recordScriptHashes(clientDirectory);
				writeGzipCopies(clientDirectory);
			},
		},
	};
	const main: Plugin = {
		name: "@ngrok/app-server",
		configResolved: (resolved) => {
			config = resolved;
			framework.validate?.(resolved);
		},
		buildStart() {
			// Why a chunk and not an input: the framework's own entry stays the same, and its prerender
			// preview reads that entry.
			if (this.environment.name === SERVER_ENVIRONMENT && this.environment.mode === "build") {
				this.emitFile({ type: "chunk", id: SERVER_ENTRY_ID, fileName: host.entryFileName });
			}
		},
		renderStart(options) {
			// Why: the server entry uses `import.meta.url`, and the CLI loads it as an ES module.
			if (this.environment.name === SERVER_ENVIRONMENT && options.format !== "es") {
				throw new Error(
					`@ngrok/app-server needs an ES module server build, and this build has the format "${options.format}".`,
				);
			}
		},
		resolveId: (id) => (id === SERVER_ENTRY_ID ? RESOLVED_SERVER_ENTRY_ID : undefined),
		load(id) {
			if (id !== RESOLVED_SERVER_ENTRY_ID || config == null) {
				return null;
			}
			const clientDirectory = outDir(config, "client");
			const serverDirectory = outDir(config, SERVER_ENVIRONMENT);
			const fromClient = relative(clientDirectory, serverDirectory);
			// Why: the static stages serve each file in the client build, so they would serve the server's
			// code. Why a build only: development serves no build directory.
			if (
				this.environment.mode === "build" &&
				!fromClient.startsWith("..") &&
				!isAbsolute(fromClient)
			) {
				throw new Error(
					`@ngrok/app-server needs the server build outside the client build, and both are in ${clientDirectory}.`,
				);
			}
			// Why a URL in a build: the build can move, and the client build stays next to it.
			const fromEntry = relative(
				dirname(join(serverDirectory, host.entryFileName)),
				clientDirectory,
			).replaceAll("\\", "/");
			return serverEntrySource({
				framework,
				host,
				appModule: app == null ? undefined : resolve(config.root, app),
				clientDirectory:
					this.environment.mode === "build"
						? `new URL(${JSON.stringify(`${fromEntry}/`)}, import.meta.url).href`
						: JSON.stringify(clientDirectory),
			});
		},
		configurePreviewServer: (server) => {
			if (framework.isPrerenderPass(server)) {
				capture(server);
			}
		},
	};
	return [main, gzipCopies];
}
