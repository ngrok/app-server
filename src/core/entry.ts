import type { MiddlewareHandler } from "hono";
import { readBuildManifest } from "./build-manifest.js";
import { serverInternals } from "./create-server.js";
import type { AppServer } from "./create-server.js";
import { errorAttributes } from "./log.js";
import { abortShutdownSignal } from "./shutdown.js";
import type {
	AppServerEnv,
	FrameworkRuntime,
	HostRuntime,
	ListenerBindings,
	Mode,
	SetupInfo,
} from "./types.js";

/** The version of the contract between the CLI and the `appServer` export of a build. */
export const ENTRY_PROTOCOL = 2;

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
	/** Development: answers one request with the dev server inside the pipeline. */
	fetchDev: (
		request: Request,
		bindings: ListenerBindings,
		devServer: MiddlewareHandler<AppServerEnv>,
	) => Promise<Response>;
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
			logger: internals.logger,
		};
	};
	let development: FrameworkRuntime | undefined;
	return {
		protocol: ENTRY_PROTOCOL,
		app,
		start: async () => {
			const runtime = framework("production");
			const shared = await setupInfo(runtime);
			const { prerendered, headers } = await readBuildManifest(shared.files);
			const info: SetupInfo = {
				...shared,
				mode: "production",
				prerenderedPaths: runtime.prerenderedPaths ?? prerendered,
				capturedHeaders: new Map(Object.entries(headers)),
			};
			await internals.prepare(info);
			const server = await internals.listen(runtime, host.listeners());
			host.lifecycle?.onStop(async () =>
				server.shutdown().catch((error: unknown) => {
					internals.logger.log("error", "shutdown failed", errorAttributes(error));
					throw error;
				}),
			);
		},
		fetchDev: async (request, bindings, devServer) => {
			development ??= framework("development");
			await internals.prepare({
				...(await setupInfo(development)),
				mode: "development",
				devServer,
				prerenderedPaths: development.prerenderedPaths ?? [],
				capturedHeaders: new Map(),
			});
			return app.fetch(request, { ...bindings, framework: development });
		},
		stopPlugins: internals.stopPlugins,
		abortShutdownSignal,
	};
}

/**
 * Whether a value is an entry of this protocol version.
 *
 * @example
 * isAppServerEntry((await import("./build/server/app-server.js")).appServer); // => true
 */
export function isAppServerEntry(value: unknown): value is AppServerEntry {
	return (
		typeof value === "object" &&
		value != null &&
		"protocol" in value &&
		value.protocol === ENTRY_PROTOCOL
	);
}
