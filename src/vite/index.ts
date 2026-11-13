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
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
	sep,
} from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { getPath } from "hono/utils/url";
import type { Environment, Plugin, PreviewServer, ResolvedConfig, Rolldown } from "vite";
import { BUILD_MANIFEST_FILE, DEFAULT_ASSETS_PATH, manifestKey } from "../core/build-manifest.js";
import type { BuildManifest } from "../core/build-manifest.js";
import { copyName, isCompressible, MIN_COMPRESS_BYTES } from "../core/compression.js";
import type { Encoding } from "../core/compression.js";
import { contentType } from "../core/static-files.js";
import { scriptHashesOf } from "../node/script-hashes.js";
import { node } from "../node/vite.js";
import { reactRouterAdapter } from "../react-router/vite.js";
import { tanstackStartAdapter } from "../tanstack-start/vite.js";
import {
	copyPackages,
	removeUntraced,
	dependencyNames,
	findPackage,
	isNativePackage,
	packageDirectoryOf,
	packageName,
	RESOLVE_CALL,
	readsOwnFiles,
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
	 * The module whose `runtime` export makes the run side. The server entry
	 * calls `runtime(serverModule, { ...runtimeOptions, mode })`. The call
	 * returns a `FrameworkRuntime`.
	 */
	runtimeModule: string;
	/**
	 * The source of an object literal with more options for `runtime`, such as
	 * a build constant of the framework. The bundler replaces the constants in
	 * it, because the source is part of the server entry.
	 */
	runtimeOptions?: string;
	/**
	 * Content types that `mime` does not know, by file extension, such as
	 * `{ ".data": "text/x-script" }`. Give the `contentTypes` of the run side.
	 * Why: the build writes the compressed copies of each file with a
	 * compressible type. With no copy, the server compresses such a file for
	 * each request.
	 */
	contentTypes?: Readonly<Record<string, string>>;
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
	/**
	 * Writes the host's deploy output, such as Vercel's `.vercel/output`. It
	 * runs one time, after the build and the prerender pass. When `appServer`
	 * comes before the framework's plugin, the pass runs after the build. Then
	 * `output` runs after the build, with no prerendered file, and again after
	 * the pass. Why sync: Vite does not wait for the end of that pass.
	 */
	output?: (build: HostOutput) => void;
};

/** What a host's `output` gets: the absolute paths of the build. */
export type HostOutput = {
	/** The Vite root. */
	root: string;
	/** The client build, such as `build/client`. */
	clientDirectory: string;
	/** The server entry, such as `build/server/app-server.js`. */
	entryFile: string;
	/**
	 * The URL path of Vite's `build.assetsDir` in the client build, such as
	 * `/assets/`. Its files have content hashes in their names.
	 */
	assetsPath: string;
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
	/**
	 * How the server build copies the packages that stay external, such as a
	 * native package. The build copies only the files that its modules can
	 * load, as `@vercel/nft` traces them. A native package and the packages
	 * that it depends on keep each file, and so does a package in
	 * `ssr.external`.
	 */
	externals?: {
		/**
		 * Packages that keep each file, such as a package that reads a file
		 * whose path the trace cannot find.
		 */
		whole?: readonly string[];
		/**
		 * Packages that the build does not copy, such as an optional dependency
		 * that a package loads in a `try`, as `@vercel/og` loads `sharp`. The
		 * server fails when it loads one with no `try`.
		 */
		omit?: readonly string[];
	};
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
		`const [serverModule, { createEntry, createServer }, { runtime }, hostModule${appModule == null ? "" : ", { default: app }"}] = await Promise.all([`,
		...modules.map((module) => `\timport(${JSON.stringify(module)}),`),
		"]);",
		...(appModule == null
			? [
					`const app = createServer({ trustForwardedProto: process.env.TRUST_FORWARDED_PROTO === "1", trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? 0) });`,
				]
			: []),
		`export const appServer = createEntry({`,
		`\tapp,`,
		`\thost: hostModule.host,`,
		`\tclientDirectory: ${clientDirectory},`,
		`\tframework: (mode) => runtime(serverModule, { ${framework.runtimeOptions == null ? "" : `...${framework.runtimeOptions}, `}mode }),`,
		`});`,
		// Why: a serverless host's function file calls the run side through the bundle's copy.
		"export { hostModule };",
		"if (import.meta.main) {",
		"\tawait appServer.start();",
		"}",
	].join("\n");
}

/** The paths of the build that a host's `output` gets. */
function hostOutput(config: ResolvedConfig, host: HostBuild): HostOutput {
	return {
		root: config.root,
		clientDirectory: outDir(config, "client"),
		entryFile: join(outDir(config, SERVER_ENVIRONMENT), host.entryFileName),
		assetsPath: urlPathOfAssetsDir(
			config.environments.client?.build.assetsDir ?? config.build.assetsDir,
		),
	};
}

/**
 * The URL path of Vite's `build.assetsDir`. Why the default for the root: an
 * immutable cache on each file of the client build would keep an old page.
 *
 * @example
 * urlPathOfAssetsDir("blog-assets/build"); // => "/blog-assets/build/"
 */
function urlPathOfAssetsDir(assetsDir: string): string {
	const path = posix.normalize(`/${assetsDir.replaceAll("\\", "/")}/`);
	return path === "/" ? DEFAULT_ASSETS_PATH : path;
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
 * Vite transforms a JSON file or an asset, such as `?raw` on a file with no
 * extension.
 */
function isJavaScriptFile(id: string): boolean {
	return isAbsolute(id) && !id.includes("?") && JAVASCRIPT_EXTENSIONS.has(extname(id));
}

/** The dependency fields of the app's `package.json` that can name a package the server imports. */
const APP_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "devDependencies"];

/** Whether `environment` builds the server. */
function isServerBuild(environment: Pick<Environment, "name" | "mode">): boolean {
	return environment.name === SERVER_ENVIRONMENT && environment.mode === "build";
}

/**
 * Makes the server build run with no install. The build bundles each
 * dependency, except the packages that the app keeps external (`ssr.external`
 * or the bundler's `external`), each native package (see `isNativePackage`),
 * each package that reads a file next to its own module (see `readsOwnFiles`),
 * and each package that the bundle shares with a package that the app keeps
 * external: the whole package of an external subpath, and each peer, at each
 * level. Those stay external, so the plugin copies each one, with its
 * dependencies, into `node_modules` in the server build, and then removes each
 * file that the build cannot load (see `removeUntraced`). A package in
 * `ssr.external`, and a package that the app reads at run time, such as
 * through `require.resolve`, keep each file. It also writes a `package.json` there, so Node, Bun, and
 * Deno load the build as ES modules and find that `node_modules`.
 */
function standalone({ whole = [], omit = [] }: AppServerOptions["externals"] = {}): Plugin {
	// Why: the app can read any file of such a package at run time.
	const readByApp = new Set<string>();
	// Why a value for each name: two copies of one external package cannot share one `node_modules`.
	const externals = new Map<string, string | undefined>();
	// Why: the bundle and an external package must share one copy of a package, such as `react`.
	const shared = new Set<string>();
	const natives = new Map<string, boolean>();
	// Why: many packages share one dependency, and each search reads its whole directory.
	const scans = new Map<string, boolean>();
	const isNative = (directory: string): boolean => {
		const native = natives.get(directory) ?? isNativePackage(directory, scans);
		natives.set(directory, native);
		return native;
	};
	// Why: many modules import one package, and each check reads the file.
	const ownFiles = new Map<string, boolean>();
	// Why `existsSync`: another plugin can give a module that is not on disk.
	const readsOwnFile = (file: string): boolean => {
		const reads = ownFiles.get(file) ?? (existsSync(file) && readsOwnFiles(file));
		ownFiles.set(file, reads);
		return reads;
	};
	// Why: a package that stays external after the bundle holds one of its peers gets a second copy.
	const inBundle = new Set<string>();
	/**
	 * Whether the bundled module `file` of package `name` must stay external:
	 * the package is native, or `file` reads a file next to it. Then the
	 * package and each of its peers stay external, so the bundle shares them.
	 */
	const staysExternal = (
		{ name, file, directory }: { name: string; file: string; directory: string | undefined },
		logger: Environment["logger"],
	): boolean => {
		const native = directory != null && isNative(directory);
		if (directory == null || (!native && !readsOwnFile(file))) {
			inBundle.add(name);
			return false;
		}
		const group = withPeers([{ name, from: directory }]);
		const held = [...group].find((peer) => inBundle.has(peer));
		// Why bundle it: a second copy of a peer, such as `react`, breaks more than a lost file.
		if (held != null && !native) {
			logger.warn(
				`@ngrok/app-server bundles "${name}", but it reads a file next to its own module, so the server can fail when it reads that file. The bundle already holds "${held}", so "${name}" cannot stay external alone. Add "${name}" to \`ssr.external\`.`,
			);
			inBundle.add(name);
			return false;
		}
		for (const peer of group) {
			shared.add(peer);
		}
		return true;
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
			readByApp.clear();
			shared.clear();
			natives.clear();
			scans.clear();
			ownFiles.clear();
			inBundle.clear();
			const { resolve: resolveOptions, build, root } = this.environment.config;
			const kept = [
				...(resolveOptions.external === true ? [] : resolveOptions.external),
				...[build.rolldownOptions.external].flat(),
			];
			const names = kept.flatMap((id) =>
				typeof id === "string" && BARE_IMPORT.test(id) ? [packageName(id)] : [],
			);
			const patterns = kept.filter(
				(id): id is Exclude<typeof id, string | undefined> => id != null && typeof id !== "string",
			);
			// Why the app's dependencies: the bundler never shows the plugin an import that a `RegExp` or
			// a function keeps external, so the build must find their peers before it bundles.
			const matched =
				patterns.length === 0 || !existsSync(join(root, "package.json"))
					? []
					: dependencyNames(root, APP_DEPENDENCY_FIELDS).filter((name) =>
							patterns.some((pattern) => matchesExternal(pattern, name)),
						);
			// Why with no import: the app can read a file of a package at run time, such as through
			// `require.resolve`.
			for (const name of names) {
				const directory = findPackage(name, root);
				if (directory != null) {
					externals.set(name, directory);
					readByApp.add(name);
				}
			}
			for (const name of withPeers(
				[...names, ...matched].map((dependency) => ({ name: dependency, from: root })),
			)) {
				shared.add(name);
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
				if (
					bundled &&
					!shared.has(name) &&
					!staysExternal({ name, file: resolved.id, directory }, this.environment.logger)
				) {
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
		transform: {
			// Why only the app's code: a package that resolves a file of another package at run time,
			// such as an optional binary, would copy a large package that the server never reads.
			filter: {
				id: { exclude: /[\\/]node_modules[\\/]/u },
				code: /\b(?:require|import\.meta)\.resolve\(/u,
			},
			handler(code, id) {
				if (!isServerBuild(this.environment)) {
					return null;
				}
				// Why: the server reads a file of the package at run time, so the build must hold the package.
				for (const { groups } of code.matchAll(RESOLVE_CALL)) {
					const source = groups?.source ?? "";
					const name = packageName(source);
					const directory =
						BARE_IMPORT.test(source) && !isBuiltin(source) && !externals.has(name)
							? findPackage(name, isAbsolute(id) ? dirname(id) : this.environment.config.root)
							: undefined;
					// Why only a package it finds: the module-graph pass in `writeBundle` can find it from another importer.
					if (directory != null) {
						externals.set(name, directory);
					}
					if (BARE_IMPORT.test(source) && !isBuiltin(source)) {
						readByApp.add(name);
					}
				}
				return null;
			},
		},
		async writeBundle() {
			if (!isServerBuild(this.environment)) {
				return;
			}
			// Why: the bundler does not call `resolveId` for a package in its own `external` option. Why
			// from the importer: with pnpm, only the importer's `node_modules` holds its dependencies.
			for (const importer of this.getModuleIds()) {
				const info = this.getModuleInfo(importer);
				for (const id of [...(info?.importedIds ?? []), ...(info?.dynamicallyImportedIds ?? [])]) {
					const name = packageName(id);
					if (BARE_IMPORT.test(id) && !isBuiltin(id) && !externals.has(name)) {
						externals.set(
							name,
							findPackage(
								name,
								isAbsolute(importer) ? dirname(importer) : this.environment.config.root,
							),
						);
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
			const copied = copyPackages(found, target, { omit: new Set(omit) });
			const kept = new Set([...whole, ...readByApp]);
			await removeUntraced(
				directory,
				copied,
				({ name, source }) => kept.has(name) || isNative(source),
			);
			writeFileSync(join(directory, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
			if (found.size > 0) {
				this.environment.logger.info(
					`@ngrok/app-server copied the external packages ${[...found.keys()].join(", ")}, with the files of their dependencies that the server build loads, into ${target}.`,
				);
			}
		},
	};
}

/**
 * Whether the app's `RegExp` or function external keeps the package `name`
 * external. Why `false` when the function throws: the build calls it with no
 * importer, and a function that reads the importer can throw.
 */
function matchesExternal(
	pattern: RegExp | ((id: string, importer: string | undefined, isResolved: boolean) => unknown),
	name: string,
): boolean {
	if (typeof pattern !== "function") {
		return name.search(pattern) !== -1;
	}
	try {
		return pattern(name, undefined, false) === true;
	} catch {
		return false;
	}
}

/**
 * Each package of `start` and each of its peers, at each level. Why each
 * level: a peer can have peers, such as `react` for `react-router`.
 */
function withPeers(start: { name: string; from: string }[]): Set<string> {
	const names = new Set<string>();
	const queue = [...start];
	for (const { name, from } of queue) {
		const directory = names.has(name) ? undefined : findPackage(name, from);
		names.add(name);
		if (directory != null) {
			for (const peer of dependencyNames(directory, ["peerDependencies"])) {
				queue.push({ name: peer, from: directory });
			}
		}
	}
	return names;
}

/**
 * `.app-server.json` while the build runs. The client build writes
 * `incomplete`, and the post step of `appServer` removes it. Why: the
 * framework starts its prerender pass with a new instance of this plugin, so
 * the file tells that instance whether the post step still comes.
 */
type DraftManifest = BuildManifest & { incomplete?: true | undefined };

/** Writes `.app-server.json` into the client build. */
function writeBuildManifest(clientDirectory: string, manifest: DraftManifest): void {
	mkdirSync(clientDirectory, { recursive: true });
	writeFileSync(
		join(clientDirectory, BUILD_MANIFEST_FILE),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
}

/**
 * Writes the build ID and the script hashes of the client build
 * ({@link scriptHashesOf}) into `.app-server.json`, removes `incomplete`, and
 * keeps the rest of the file. Why the script hashes of each build: a build
 * with no prerender pass can have HTML files, such as `public/offline.html`.
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
		// Why `undefined`: JSON leaves out a field with no value.
		incomplete: undefined,
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

/**
 * The `buildId`, the `assetsPath`, and `incomplete` of the build manifest
 * that the client build wrote. Why keep them: the prerender pass runs after
 * the client build, which knows them.
 */
function clientBuildFields(
	clientDirectory: string,
): Pick<DraftManifest, "buildId" | "assetsPath" | "incomplete"> {
	const path = join(clientDirectory, BUILD_MANIFEST_FILE);
	const manifest: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
	if (typeof manifest !== "object" || manifest == null) {
		return {};
	}
	return {
		...("buildId" in manifest && typeof manifest.buildId === "string"
			? { buildId: manifest.buildId }
			: {}),
		...("assetsPath" in manifest && typeof manifest.assetsPath === "string"
			? { assetsPath: manifest.assetsPath }
			: {}),
		...("incomplete" in manifest && manifest.incomplete === true ? { incomplete: true } : {}),
	};
}

/**
 * Records each 2xx path and the headers of each non-document response while
 * the framework's prerender pass runs. It writes them to `.app-server.json` in
 * the client build when the preview server closes. When the post step of the
 * build ran before the pass, it also does the work of that step for the files
 * of the pass: the script hashes, the copies, and `afterPass`.
 */
function capture(
	server: PreviewServer,
	{
		contentTypes,
		afterPass,
	}: { contentTypes: FrameworkBuild["contentTypes"]; afterPass: () => void },
): void {
	const clientDirectory = outDir(server.config, "client");
	const started = Date.now();
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
	// Why sync: Vite does not wait for this listener.
	server.httpServer.once("close", () => {
		const recorded = clientBuildFields(clientDirectory);
		// Why: with `incomplete`, the post step of the build comes after this pass, and it does this
		// work for each file. Without it, that step ran before this pass, as it does when `appServer`
		// comes before the framework's plugin.
		const afterPostStep = recorded.incomplete !== true;
		writeBuildManifest(clientDirectory, {
			...recorded,
			prerendered: [...paths].toSorted(),
			headers: Object.fromEntries(
				Object.entries(headers).toSorted(([first], [second]) => first.localeCompare(second)),
			),
			scriptHashes: afterPostStep ? scriptHashesOf(clientDirectory) : {},
		});
		if (afterPostStep) {
			// Why each file that the pass changed, not each path: a path does not name its file, as
			// TanStack Start can write `/page` to `page.html`. Why 2 s early: a file system can keep the
			// modification time in steps of 1 or 2 s.
			writeAllCopies(clientDirectory, { changedSince: started - 2000, contentTypes });
			afterPass();
		}
	});
}

/**
 * The brotli quality of the copies. Why 9, not the highest (11): on a docs
 * build with 70 MB of text, 11 adds 46 s to the build and 9 adds 0.6 s. The
 * copies of 9 are 9% larger, and still 25% smaller than the gzip copies.
 */
const BROTLI_QUALITY = 9;

/**
 * Writes the compressed copies (`.<file>.gz` and `.<file>.br`) of the file at
 * `path` when the server compresses the file: a compressible type of 1 KiB
 * or more. `contentTypes` are the framework's types, as the server reads
 * them. It writes a copy only when it is smaller: the gzip copy than the
 * file, and the brotli copy than the gzip copy. Else it removes an old copy,
 * so a copy from an earlier build never replaces a changed file.
 */
function writeCopies(path: string, contentTypes: Readonly<Record<string, string>>): void {
	const bytes =
		isCompressible(contentType(path, contentTypes)) &&
		statSync(path, { throwIfNoEntry: false })?.isFile() === true
			? readFileSync(path)
			: undefined;
	// Why the highest gzip level: the build compresses each file once, and each response sends fewer bytes.
	const gzip =
		bytes == null || bytes.byteLength < MIN_COMPRESS_BYTES
			? undefined
			: gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION });
	const gzipCopy =
		gzip != null && bytes != null && gzip.byteLength < bytes.byteLength ? gzip : undefined;
	const brotli =
		gzipCopy == null || bytes == null
			? undefined
			: brotliCompressSync(bytes, {
					params: {
						[constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
						[constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
						[constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
					},
				});
	const brotliCopy =
		brotli != null && gzipCopy != null && brotli.byteLength < gzipCopy.byteLength
			? brotli
			: undefined;
	const copies: readonly (readonly [Encoding, Uint8Array | undefined])[] = [
		["gzip", gzipCopy],
		["br", brotliCopy],
	];
	for (const [encoding, copy] of copies) {
		const copyPath = join(dirname(path), copyName(basename(path), encoding));
		if (copy == null) {
			rmSync(copyPath, { force: true });
		} else {
			writeFileSync(copyPath, copy);
		}
	}
}

/**
 * Runs {@link writeCopies} for each file in the client build, except dotfiles
 * such as the copies, and except a link or a file in a linked directory. With `changedSince`, only for a file that changed at or
 * after that time, in milliseconds since the epoch.
 */
function writeAllCopies(
	clientDirectory: string,
	{
		changedSince,
		contentTypes = {},
	}: { changedSince?: number; contentTypes: FrameworkBuild["contentTypes"] },
): void {
	if (!existsSync(clientDirectory)) {
		return;
	}
	for (const path of filesInside(clientDirectory)) {
		// Why skip dotfiles: the server never sends one, such as `.app-server.json`.
		if (
			!basename(path).startsWith(".") &&
			(changedSince == null ||
				(statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0) >= changedSince)
		) {
			writeCopies(path, contentTypes);
		}
	}
}

/**
 * The path of each file under `directory`. Why not through a link: a copy goes
 * next to its file, so a file in a linked directory would get its copies in
 * the link's target, outside the client build.
 */
function filesInside(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			return filesInside(path);
		}
		return entry.isFile() ? [path] : [];
	});
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
 *   `contentSecurityPolicy` plugin. It also writes a gzip copy (`.<file>.gz`)
 *   and a brotli copy (`.<file>.br`) next to each text file of 1 KiB or more
 *   in the client build, HTML included. The static stages send a copy, so the
 *   server does not compress these files for each request.
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
	const postStep: Plugin = {
		name: "@ngrok/app-server:compressed-copies",
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
				writeAllCopies(clientDirectory, { contentTypes: resolved?.framework.contentTypes });
				host.output?.(hostOutput(builder.config, host));
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
					assetsPath: urlPathOfAssetsDir(this.environment.config.build.assetsDir),
					prerendered: [],
					headers: {},
					scriptHashes: {},
					// Why: the post step of this build completes the file. Until then, a prerender pass
					// leaves the script hashes, the copies, and the host's output to that step.
					incomplete: true,
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
				capture(server, {
					contentTypes: resolved.framework.contentTypes,
					// Why the preview's config: the framework starts the preview with a new instance of this plugin.
					afterPass: () => host.output?.(hostOutput(server.config, host)),
				});
			}
		},
	};
	return [main, postStep, standalone(options.externals)];
}
