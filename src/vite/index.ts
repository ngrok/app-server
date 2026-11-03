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
import { isBuiltin } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { constants, gzipSync } from "node:zlib";
import { getPath } from "hono/utils/url";
import type { Environment, Plugin, PreviewServer, ResolvedConfig, Rolldown } from "vite";
import { BUILD_MANIFEST_FILE, manifestKey } from "../core/build-manifest.js";
import type { BuildManifest } from "../core/build-manifest.js";
import { gzipCopyName, isCompressible, MIN_GZIP_BYTES } from "../core/gzip-rules.js";
import { contentType } from "../core/static-files.js";
import { node } from "../node/vite.js";
import { reactRouterAdapter } from "../react-router/vite.js";
import { tanstackStartAdapter } from "../tanstack-start/vite.js";
import {
	copyPackages,
	dependencyNames,
	findPackage,
	isNativePackage,
	packageDirectoryOf,
	packageName,
} from "./standalone.js";

/** The module ID of the server entry that {@link appServer} generates. */
export const SERVER_ENTRY_ID = "virtual:@ngrok/app-server/entry";
const RESOLVED_SERVER_ENTRY_ID = `\0${SERVER_ENTRY_ID}`;

/** The Vite environment that builds the server. */
const SERVER_ENVIRONMENT = "ssr";

/** A bare import, such as `react` or `@scope/name/path`: not a path, a `\0` ID, or a `node:` or `virtual:` ID. */
const BARE_IMPORT = /^[\w@][^:]*$/u;

/** The file extensions of a module that Node imports as it is, with no transform by Vite. */
const JAVASCRIPT_EXTENSIONS = new Set(["", ".js", ".mjs", ".cjs"]);

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
	/**
	 * The framework adapter. When omitted, the plugin finds the React Router or
	 * TanStack Start plugin in the Vite config. It throws when it finds neither
	 * or both.
	 */
	framework?: FrameworkBuild;
	/** The host adapter. Default `node()`. */
	host?: HostBuild;
	/**
	 * The module whose default export is the app from `createServer`, relative
	 * to the Vite root. When omitted, the plugin uses `server.ts`, else
	 * `server.js`, in the Vite root. When neither exists, the server uses its
	 * default plugins.
	 */
	app?: string;
};

/** The built-in framework adapters, each with the name of the Vite plugin that marks its framework. */
const FRAMEWORKS = [
	// Why not the `react-router` plugin: React Router's child compiler drops that plugin and keeps
	// this one, which serves the server module.
	{ plugin: "react-router:virtual-modules", adapter: reactRouterAdapter },
	{ plugin: "tanstack-react-start:config", adapter: tanstackStartAdapter },
];

/** The adapter of the one built-in framework whose plugin is in the Vite config. */
function detectFramework(plugins: readonly Plugin[]): FrameworkBuild {
	const names = new Set(plugins.map((plugin) => plugin.name));
	const [found, ...others] = FRAMEWORKS.filter(({ plugin }) => names.has(plugin));
	if (found == null) {
		throw new Error(
			"@ngrok/app-server found no React Router or TanStack Start plugin in the Vite config. Add the framework's plugin, or pass `framework` to `appServer`.",
		);
	}
	if (others.length > 0) {
		throw new Error(
			"@ngrok/app-server found the React Router and the TanStack Start plugins in the Vite config. Pass `framework` to `appServer`.",
		);
	}
	return found.adapter();
}

/** The absolute path of `server.ts` or `server.js` in `root`, else `undefined` for the default app. */
function defaultApp(root: string): string | undefined {
	return ["server.ts", "server.js"]
		.map((name) => join(root, name))
		.find((path) => existsSync(path));
}

/** What {@link serverEntrySource} needs. */
type EntrySource = {
	framework: Pick<FrameworkBuild, "serverModule" | "runtimeModule" | "runtimeOptions">;
	host: Pick<HostBuild, "runtimeModule">;
	/** The absolute path of the app module, else `undefined` for the default app. */
	appModule: string | undefined;
	/** The source of an expression that gives the client build: a path or a `file:` URL. */
	clientDirectory: string;
};

/**
 * The source of the server entry. When a runtime runs the file as its main
 * module, such as `node build/server/app-server.js`, the entry starts the
 * server. When the CLI imports it, the CLI starts the server.
 */
export function serverEntrySource({
	framework,
	host,
	appModule,
	clientDirectory,
}: EntrySource): string {
	const modules = [
		framework.serverModule,
		// Why from the bundle: the CLI calls this export, so the server runs on the bundle's copy of
		// this package and of the framework, the same copies as the app and the routes.
		"@ngrok/app-server",
		framework.runtimeModule,
		host.runtimeModule,
		...(appModule == null ? [] : [appModule]),
	];
	return [
		// Why before the imports: React reads `NODE_ENV` when it loads. Why dynamic imports: a static
		// import loads before this line.
		"if (import.meta.main) {",
		'\tprocess.env.NODE_ENV ??= "production";',
		'\tif (typeof process.setSourceMapsEnabled === "function") {',
		"\t\tprocess.setSourceMapsEnabled(true);",
		"\t}",
		"}",
		`const [serverModule, { createEntry, createServer }, { runtime }, { host }${appModule == null ? "" : ", { default: app }"}] = await Promise.all([`,
		...modules.map((module) => `\timport(${JSON.stringify(module)}),`),
		"]);",
		...(appModule == null
			? [
					`const app = createServer({ trustForwardedProto: process.env.TRUST_FORWARDED_PROTO === "1", trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? 0) });`,
				]
			: []),
		`export const appServer = createEntry({`,
		`\tapp,`,
		`\thost,`,
		`\tclientDirectory: ${clientDirectory},`,
		`\tframework: (mode) => runtime(serverModule, { ${framework.runtimeOptions == null ? "" : `...${framework.runtimeOptions}, `}mode }),`,
		`});`,
		"if (import.meta.main) {",
		"\tawait appServer.start();",
		"}",
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
 * Whether `id` is a JavaScript file, which Node imports from `node_modules`
 * as it is. Why: a plugin can resolve a bare import to a virtual module, and
 * Vite transforms a JSON file or an asset, such as `?raw`.
 */
function isJavaScriptFile(id: string): boolean {
	return isAbsolute(id) && JAVASCRIPT_EXTENSIONS.has(extname(id));
}

/** Whether `environment` builds the server. */
function isServerBuild(environment: Pick<Environment, "name" | "mode">): boolean {
	return environment.name === SERVER_ENVIRONMENT && environment.mode === "build";
}

/**
 * Makes the server build run with no install. The build bundles each
 * dependency, except the packages that the app keeps external (`ssr.external`
 * or the bundler's `external`), each native package (see `isNativePackage`),
 * and each peer dependency of a package that the app keeps external. Those stay
 * external, so the plugin copies each one, whole, with its dependencies, into
 * `node_modules` in the server build. It also writes a `package.json` there, so
 * Node, Bun, and Deno load the build as ES modules and find that `node_modules`.
 */
function standalone(): Plugin {
	// Why a value for each name: two copies of one external package cannot share one `node_modules`.
	const externals = new Map<string, string | undefined>();
	// Why: the bundle and an external package must share one copy of each peer, such as `react`.
	const peers = new Set<string>();
	const natives = new Map<string, boolean>();
	const isNative = (directory: string): boolean => {
		const native = natives.get(directory) ?? isNativePackage(directory);
		natives.set(directory, native);
		return native;
	};
	return {
		name: "@ngrok/app-server:standalone",
		// Why `pre`: Vite's resolver runs before a plugin with no `enforce`, so that plugin cannot keep
		// a native package out of the bundle.
		enforce: "pre",
		config: (config, { command }) => {
			const ssr = config.environments?.[SERVER_ENVIRONMENT]?.resolve;
			// Why a build only: in development, Vite loads each dependency from `node_modules`. Why not
			// with the app's value: Vite merges `true` over a list, and `noExternal: true` wins over
			// `external: true`, so the app's value then has no effect.
			return command === "build" &&
				config.ssr?.noExternal == null &&
				ssr?.noExternal == null &&
				config.ssr?.external !== true &&
				ssr?.external !== true
				? { ssr: { noExternal: true } }
				: undefined;
		},
		buildStart() {
			if (!isServerBuild(this.environment)) {
				return;
			}
			externals.clear();
			peers.clear();
			natives.clear();
			const { resolve: resolveOptions, build, root } = this.environment.config;
			const kept = [
				...(resolveOptions.external === true ? [] : resolveOptions.external),
				...[build.rolldownOptions.external].flat(),
			];
			for (const id of kept) {
				const directory =
					typeof id === "string" && BARE_IMPORT.test(id)
						? findPackage(packageName(id), root)
						: undefined;
				for (const peer of directory == null
					? []
					: dependencyNames(directory, ["peerDependencies"])) {
					peers.add(peer);
				}
			}
		},
		resolveId: {
			filter: { id: BARE_IMPORT },
			async handler(source, importer, options) {
				if (!isServerBuild(this.environment) || isBuiltin(source)) {
					return null;
				}
				const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
				const bundled = resolved?.external === false;
				if (resolved == null || (bundled && !isJavaScriptFile(resolved.id))) {
					return resolved;
				}
				const name = packageName(source);
				// Why the resolved file first: Vite can pick another copy than Node, such as for
				// `resolve.dedupe`.
				const directory =
					(bundled ? packageDirectoryOf(resolved.id, name) : undefined) ??
					findPackage(
						name,
						importer != null && isAbsolute(importer)
							? dirname(importer)
							: this.environment.config.root,
					);
				if (bundled && !peers.has(name) && (directory == null || !isNative(directory))) {
					return resolved;
				}
				const known = externals.get(name);
				if (known != null && directory != null && known !== directory) {
					throw new Error(
						`@ngrok/app-server found two copies of "${name}" that stay external, and the server build can hold one: ${known} and ${directory}. Install one version of "${name}".`,
					);
				}
				externals.set(name, known ?? directory);
				return bundled ? { id: source, external: true } : resolved;
			},
		},
		writeBundle(_options, bundle) {
			if (!isServerBuild(this.environment)) {
				return;
			}
			const { root } = this.environment.config;
			// Why: the bundler does not call `resolveId` for a package in its own `external` option.
			for (const output of Object.values(bundle)) {
				for (const id of output.type === "chunk"
					? [...output.imports, ...output.dynamicImports]
					: []) {
					const name = packageName(id);
					if (BARE_IMPORT.test(id) && !isBuiltin(id) && !(id in bundle) && !externals.has(name)) {
						externals.set(name, findPackage(name, root));
					}
				}
			}
			const directory = outDir(this.environment.getTopLevelConfig(), SERVER_ENVIRONMENT);
			const found = new Map<string, string>();
			for (const [name, source] of externals) {
				if (source == null) {
					this.environment.logger.warn(
						`@ngrok/app-server cannot find "${name}", which stays external, so the server build does not hold it. The server fails if it imports "${name}".`,
					);
				} else {
					found.set(name, source);
				}
			}
			const target = join(directory, "node_modules");
			rmSync(target, { recursive: true, force: true });
			copyPackages(found, target);
			writeFileSync(join(directory, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
			if (found.size > 0) {
				this.environment.logger.info(
					`@ngrok/app-server copied the external packages ${[...found.keys()].join(", ")}, with their dependencies, into ${target}.`,
				);
			}
		},
	};
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
 * The base64 `SHA-256` of each inline script in `html`, once each, in
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
	mkdirSync(clientDirectory, { recursive: true });
	writeFileSync(
		join(clientDirectory, BUILD_MANIFEST_FILE),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
}

/**
 * Writes the build ID and the script hashes of the client build
 * ({@link scriptHashesOf}) into `.app-server.json`, and keeps the rest of the
 * file. Why after the build too: a build with no prerender pass can have HTML
 * files, such as `public/offline.html`.
 */
function completeBuildManifest(clientDirectory: string, buildId: string | undefined): void {
	if (!existsSync(clientDirectory)) {
		return;
	}
	const path = join(clientDirectory, BUILD_MANIFEST_FILE);
	const recorded: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
	writeBuildManifest(clientDirectory, {
		prerendered: [],
		headers: {},
		...(typeof recorded === "object" && recorded != null ? recorded : {}),
		...(buildId == null ? {} : { buildId }),
		scriptHashes: scriptHashesOf(clientDirectory),
	});
}

/**
 * The ID of a client build: a hash of the name and the content of each file
 * in its bundle. Why the bundle: it is the code that an open tab runs, so the
 * ID changes when that code changes, and not for a change to the server, a
 * `public/` file, or a prerendered page. Why the content, not the file
 * names: a name has a content hash only when the output names ask for one.
 */
function bundleBuildId(bundle: Rolldown.OutputBundle): string {
	const hash = createHash("sha256");
	// Why `<`, not `localeCompare`: the order of `localeCompare` changes with the locale of the
	// machine, so two machines would give one bundle two IDs.
	for (const file of Object.values(bundle).toSorted((first, second) =>
		first.fileName < second.fileName ? -1 : 1,
	)) {
		hash.update(`${file.fileName}\0`);
		hash.update(file.type === "chunk" ? file.code : file.source);
		hash.update("\0");
	}
	// Why 16 hex digits: 64 bits keep two builds apart, and the ID goes in each document's headers.
	return hash.digest("hex").slice(0, 16);
}

/** The path of each file under `directory` that is not a dotfile, in code unit order. */
function filesIn(directory: string): string[] {
	if (!existsSync(directory)) {
		return [];
	}
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && !entry.name.startsWith("."))
		.map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.toSorted();
}

/** The client build, as its `writeBundle` hook saw it. */
type ClientBuild = {
	/** The {@link bundleBuildId} of the client bundle. */
	bundleId: string;
	/** The assets directory of the client build, such as `build/client/assets`. */
	assetsDirectory: string;
	/** The files in the assets directory ({@link filesIn}) after the client build wrote its bundle. */
	assets: ReadonlySet<string>;
};

/**
 * The ID of the whole build: the {@link bundleBuildId} of the client bundle,
 * with the name and the content of each file that a later build step added to
 * the assets directory. Why: React Router writes its route manifest
 * (`assets/manifest-*.js`) during the server build, and a route change, such
 * as a new path for one module, can keep the client bundle the same.
 */
function appBuildId({ bundleId, assetsDirectory, assets }: ClientBuild): string {
	const added = filesIn(assetsDirectory).filter((file) => !assets.has(file));
	if (added.length === 0) {
		return bundleId;
	}
	const hash = createHash("sha256").update(bundleId);
	for (const file of added) {
		hash.update(`\0${file}\0`);
		hash.update(readFileSync(join(assetsDirectory, file)));
	}
	return hash.digest("hex").slice(0, 16);
}

/** The `buildId` of the build manifest that the client build wrote, if any. */
function writtenBuildId(clientDirectory: string): string | undefined {
	const path = join(clientDirectory, BUILD_MANIFEST_FILE);
	if (!existsSync(path)) {
		return undefined;
	}
	const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
	return typeof manifest === "object" &&
		manifest != null &&
		"buildId" in manifest &&
		typeof manifest.buildId === "string"
		? manifest.buildId
		: undefined;
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
		const buildId = writtenBuildId(clientDirectory);
		writeBuildManifest(clientDirectory, {
			// Why keep it: the prerender pass runs after the client build, which derived it.
			...(buildId == null ? {} : { buildId }),
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
 *   The framework's own entry does not change. When a runtime runs the entry
 *   as its main module, the entry starts the server.
 * - In a build, it bundles each dependency into the server build. It copies
 *   each package that stays external into `node_modules` in the server build.
 *   So the build directory runs with no install.
 * - After the client build, it writes `.app-server.json` in the client
 *   build with the build ID: a hash of the client bundle. After the build,
 *   it adds the files that the server build wrote to the client's assets
 *   directory, such as React Router's route manifest. The `buildId` plugin
 *   sends the ID.
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
 * export default defineConfig({ plugins: [reactRouter(), appServer()] });
 */
export function appServer(options: AppServerOptions = {}): Plugin[] {
	const host = options.host ?? node();
	// Why one value: `configResolved` sets all three, so no hook sees a config with no framework.
	let resolved:
		| { config: ResolvedConfig; framework: FrameworkBuild; appModule: string | undefined }
		| undefined;
	let clientBuild: ClientBuild | undefined;
	const gzipCopies: Plugin = {
		name: "@ngrok/app-server:gzip-copies",
		// Why last: the framework prerenders in a `buildApp` hook of an `enforce: "post"` plugin.
		enforce: "post",
		buildApp: {
			order: "post",
			handler: async (builder) => {
				const clientDirectory = outDir(builder.config, "client");
				completeBuildManifest(
					clientDirectory,
					clientBuild == null ? undefined : appBuildId(clientBuild),
				);
				writeGzipCopies(clientDirectory);
			},
		},
	};
	const main: Plugin = {
		name: "@ngrok/app-server",
		configResolved: (config) => {
			const framework = options.framework ?? detectFramework(config.plugins);
			framework.validate?.(config);
			resolved = {
				config,
				framework,
				appModule:
					options.app == null ? defaultApp(config.root) : resolve(config.root, options.app),
			};
		},
		buildStart() {
			// Why a chunk and not an input: the framework's own entry stays the same, and its prerender
			// preview reads that entry.
			if (isServerBuild(this.environment)) {
				this.emitFile({ type: "chunk", id: SERVER_ENTRY_ID, fileName: host.entryFileName });
			}
		},
		writeBundle(output, bundle) {
			if (this.environment.name === "client") {
				const directory = output.dir ?? outDir(this.environment.config, "client");
				const assetsDirectory = join(directory, this.environment.config.build.assetsDir);
				clientBuild = {
					bundleId: bundleBuildId(bundle),
					assetsDirectory,
					assets: new Set(filesIn(assetsDirectory)),
				};
				writeBuildManifest(directory, {
					buildId: clientBuild.bundleId,
					prerendered: [],
					headers: {},
					scriptHashes: {},
				});
			}
		},
		renderStart(output) {
			// Why: the server entry uses `import.meta.url`, and the CLI loads it as an ES module.
			if (this.environment.name === SERVER_ENVIRONMENT && output.format !== "es") {
				throw new Error(
					`@ngrok/app-server needs an ES module server build, and this build has the format "${output.format}".`,
				);
			}
		},
		resolveId: (id) => (id === SERVER_ENTRY_ID ? RESOLVED_SERVER_ENTRY_ID : undefined),
		load(id) {
			if (id !== RESOLVED_SERVER_ENTRY_ID || resolved == null) {
				return null;
			}
			const { config, framework, appModule } = resolved;
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
				appModule,
				clientDirectory:
					this.environment.mode === "build"
						? `new URL(${JSON.stringify(`${fromEntry}/`)}, import.meta.url).href`
						: JSON.stringify(clientDirectory),
			});
		},
		configurePreviewServer: (server) => {
			if (resolved?.framework.isPrerenderPass(server) === true) {
				capture(server);
			}
		},
	};
	return [main, gzipCopies, standalone()];
}
