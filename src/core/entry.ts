import type { MiddlewareHandler } from "hono";
import { DEFAULT_ASSETS_PATH, readBuildManifest } from "./build-manifest.js";
import { serverInternals } from "./create-server.js";
import type { AppServer } from "./create-server.js";
import { ENTRY_PROTOCOL } from "./entry-protocol.js";
import { asError, sinkLogger } from "./log.js";
import { abortShutdownSignal } from "./shutdown.js";
import { staticPages } from "./static-pages.js";
import type { StaticPage } from "./static-pages.js";
import { keptFiles } from "./static-files.js";
import type {
	AppServerEnv,
	FetchHandler,
	FrameworkRuntime,
	HostRuntime,
	ListenerBindings,
	Mode,
	SetupInfo,
} from "./types.js";

/**
 * What a server build exports as `appServer`. The CLI calls it, so the copy
 * of this package in the build runs the server, and the CLI's copy runs
 * nothing.
 */
export type AppServerEntry = {
	/** The CLI refuses an entry with another version. */
	protocol: typeof ENTRY_PROTOCOL;
	/** The app. Two entries with the same app share its plugins. */
	app: AppServer;
	/**
	 * Production: runs each plugin's `setup` and listens. When the host's
	 * lifecycle stops, such as on `SIGTERM`, it shuts down.
	 */
	start: () => Promise<void>;
	/**
	 * Production, for a serverless host: answers one request, and does not
	 * listen. The first call runs each plugin's `setup`.
	 */
	fetch: FetchHandler;
	/** Development: answers one request with the dev server inside the pipeline. */
	fetchDev: (
		request: Request,
		bindings: ListenerBindings,
		devServer: MiddlewareHandler<AppServerEnv>,
	) => Promise<Response>;
	/**
	 * Production, for a build step: each prerendered path, with the answer
	 * that a content delivery network (CDN) can send with no server, or the
	 * reason that the server must answer it. The first call runs each
	 * plugin's `setup`. See `staticPages`.
	 */
	staticPages: () => AsyncGenerator<StaticPage>;
	/** Runs each plugin's `onShutdown` once, up to the shutdown deadline. */
	stopPlugins: () => Promise<void>;
	/** Aborts `shutdownSignal()` of this copy of the package. */
	abortShutdownSignal: () => void;
};

/** Options for {@link createEntry}. */
export type CreateEntryOptions = {
	/** The app from `createServer`. */
	app: AppServer;
	/** The run side of the host adapter, such as `host` from `@ngrok/app-server/node`. */
	host: HostRuntime;
	/** Makes the run side of the framework adapter for a mode. */
	framework: (mode: Mode) => FrameworkRuntime;
	/**
	 * The client build, as a file path or a `file:` URL. The entry that the
	 * Vite plugin generates sets it.
	 * @default the framework's `clientDirectory`
	 */
	clientDirectory?: string;
};

/**
 * The `appServer` export of a server build: an app from `createServer`, the
 * host, and the framework adapter for each mode. The `appServer` Vite plugin
 * generates this export. Call this for a build without the plugin.
 *
 * @example
 * export const appServer = createEntry({ app, host, framework: (mode) => runtime(build, { mode }) });
 */
export function createEntry({
	app,
	host,
	framework,
	clientDirectory,
}: CreateEntryOptions): AppServerEntry {
	const internals = serverInternals(app);
	if (internals == null) {
		throw new Error(
			"The app is not from `createServer()` of the copy of @ngrok/app-server in this build.",
		);
	}
	internals.setRequestStore(host.storage);
	const logger = sinkLogger(internals.logger);
	const setupInfo = async (runtime: FrameworkRuntime) => {
		const directory = clientDirectory ?? runtime.clientDirectory;
		if (directory == null) {
			throw new Error(
				`Give createEntry a clientDirectory: the ${runtime.name} adapter does not know the client build.`,
			);
		}
		const files = host.files(directory);
		return {
			files,
			isDataRequest: runtime.isDataRequest ?? (() => false),
			contentTypes: runtime.contentTypes ?? {},
			gzip: host.gzip,
			brotli: host.brotli,
			logger,
		};
	};
	let prerenderedPaths: readonly string[] = [];
	/** The production run side, after each `setup` ran. */
	let ready: FrameworkRuntime | undefined;
	/** Runs each plugin's `setup` for production, and gives the framework's run side. */
	const prepareProduction = async (): Promise<FrameworkRuntime> => {
		const runtime = framework("production");
		const shared = await setupInfo(runtime);
		const snapshot = await shared.files.snapshot?.();
		// Why before `keptFiles`: no request reads the manifest, so its bytes must not stay in memory.
		const manifest = await readBuildManifest(snapshot ?? shared.files);
		// Why only with a snapshot: it promises that the client build does not change while the server runs.
		const files = snapshot == null ? shared.files : keptFiles(snapshot);
		const info: SetupInfo = {
			...shared,
			files,
			mode: "production",
			prerenderedPaths: runtime.prerenderedPaths ?? manifest.prerendered,
			capturedHeaders: new Map(Object.entries(manifest.headers)),
			scriptHashes: new Map(Object.entries(manifest.scriptHashes)),
			buildId: manifest.buildId,
			assetsPath: manifest.assetsPath ?? DEFAULT_ASSETS_PATH,
		};
		await internals.prepare(info);
		({ prerenderedPaths } = info);
		ready = runtime;
		return runtime;
	};
	let preparing: Promise<FrameworkRuntime> | undefined;
	/**
	 * The production run side, set up once. Why forget a failure: a serverless
	 * instance stays up, so the next request runs each `setup` again.
	 */
	const production = async (): Promise<FrameworkRuntime> => {
		preparing ??= prepareProduction().catch((error: unknown) => {
			preparing = undefined;
			throw error;
		});
		return preparing;
	};
	/** Answers a request that comes before the setup ends. */
	const fetchAfterSetup = async (
		request: Request,
		bindings: ListenerBindings | undefined,
	): Promise<Response> => {
		// Why log it: the host sends a 500 with no log, and no app handler runs before setup ends.
		const runtime = await production().catch((error: unknown) => {
			internals.logger.log({
				level: "error",
				message: "setup failed",
				attributes: { error: asError(error) },
			});
			throw error;
		});
		return app.fetch(request, { ...bindings, framework: runtime });
	};
	let development: FrameworkRuntime | undefined;
	let developmentReady = false;
	return {
		protocol: ENTRY_PROTOCOL,
		app,
		start: async () => {
			const runtime = await production();
			const server = await internals.listen(runtime, host.listeners?.());
			host.lifecycle?.onStop(async () =>
				server.shutdown().catch((error: unknown) => {
					internals.logger.log({
						level: "error",
						message: "shutdown failed",
						attributes: { error: asError(error) },
					});
					throw error;
				}),
			);
		},
		// Why not `async`: after the setup, a request then waits for the app's promise alone.
		fetch: (request, bindings): Response | Promise<Response> =>
			ready == null
				? fetchAfterSetup(request, bindings)
				: app.fetch(request, { ...bindings, framework: ready }),
		fetchDev: async (request, bindings, devServer) => {
			development ??= framework("development");
			// Why only until it succeeds: `prepare` reads the info of its first call. After a failure,
			// the next request runs each `setup` again.
			if (!developmentReady) {
				await internals.prepare({
					...(await setupInfo(development)),
					mode: "development",
					devServer,
					prerenderedPaths: development.prerenderedPaths,
					capturedHeaders: new Map(),
					scriptHashes: new Map(),
					// Why none: development has no client build, and Vite's HMR updates an open tab after each edit.
					buildId: undefined,
				});
				developmentReady = true;
			}
			return app.fetch(request, { ...bindings, framework: development });
		},
		async *staticPages() {
			const runtime = await production();
			yield* staticPages(
				async (request, bindings) => app.fetch(request, { ...bindings, framework: runtime }),
				prerenderedPaths,
				{ presence: internals.presenceHeaders, perRequest: internals.perRequestHeaders },
			);
		},
		stopPlugins: internals.stopPlugins,
		abortShutdownSignal,
	};
}
