import { serverInternals, type AppServer } from "./create-server.js";
import { exitAfterFlush } from "./exit.js";
import { errorAttributes } from "./log.js";
import { abortShutdownSignal } from "./shutdown.js";
import type { FrameworkAdapter, ListenerBindings, NodeMiddleware, SetupInfo } from "./types.js";

/** The version of the contract between the CLI and the `appServer` export of a build. */
export const ENTRY_PROTOCOL = 1;

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
	 * Production: runs each plugin's `setup` and listens. On `SIGTERM` or
	 * `SIGINT`, it shuts down, then exits the process.
	 */
	start: () => Promise<void>;
	/** Development: answers one request with Vite's middleware inside the pipeline. */
	fetchDev: (
		request: Request,
		bindings: ListenerBindings,
		viteMiddleware: NodeMiddleware,
	) => Promise<Response>;
	/** Runs each plugin's `onShutdown` once, up to the shutdown deadline. */
	stopPlugins: () => Promise<void>;
	/** Aborts `shutdownSignal()` of this copy of the package. */
	abortShutdownSignal: () => void;
};

/**
 * The `appServer` export of a server build: an app from `createServer` and
 * the framework adapter for each mode. The `serverEntry` Vite plugin makes
 * this export for a React Router build. Call this for another framework.
 *
 * @example
 * export const appServer = createEntry({ app, framework: (mode) => myAdapter(build, mode) });
 */
export function createEntry({
	app,
	framework,
}: {
	app: AppServer;
	framework: (mode: SetupInfo["mode"]) => FrameworkAdapter;
}): AppServerEntry {
	const internals = serverInternals(app);
	if (internals == null) {
		throw new Error(
			"The app is not from `createServer()` of the copy of @ngrok/app-server in this build.",
		);
	}
	let development: FrameworkAdapter | undefined;
	return {
		protocol: ENTRY_PROTOCOL,
		app,
		start: async () => {
			const adapter = framework("production");
			await internals.prepare({
				mode: "production",
				clientDirectory: adapter.clientDirectory,
				prerenderedPaths: adapter.prerenderedPaths,
				logger: internals.logger,
			});
			const server = await internals.listen(adapter);
			for (const signal of ["SIGTERM", "SIGINT"] as const) {
				process.once(signal, () => {
					server
						.shutdown()
						.catch((error: unknown) => {
							internals.logger.log("error", "shutdown failed", errorAttributes(error));
							process.exitCode = 1;
						})
						.finally(exitAfterFlush);
				});
			}
		},
		fetchDev: async (request, bindings, viteMiddleware) => {
			development ??= framework("development");
			await internals.prepare({
				mode: "development",
				viteMiddleware,
				clientDirectory: development.clientDirectory,
				prerenderedPaths: development.prerenderedPaths,
				logger: internals.logger,
			});
			return app.fetch(request, { ...bindings, framework: development });
		},
		stopPlugins: internals.stopPlugins,
		abortShutdownSignal,
	};
}

function isAppServerEntry(value: unknown): value is AppServerEntry {
	return (
		typeof value === "object" &&
		value != null &&
		"protocol" in value &&
		value.protocol === ENTRY_PROTOCOL
	);
}

/** Entries that this copy made for plain React Router builds, by build module. */
const plainEntries = new WeakMap<object, AppServerEntry>();

/**
 * The entry that runs a server build: its `appServer` export when the
 * `serverEntry` Vite plugin made it, else this copy of the package over a
 * plain React Router build with the default plugins.
 */
export async function loadEntry(build: unknown): Promise<AppServerEntry> {
	if (typeof build !== "object" || build == null) {
		throw new Error("The server build entry is not a module.");
	}
	const exported: unknown = Reflect.get(build, "appServer");
	if (exported != null) {
		if (!isAppServerEntry(exported)) {
			throw new Error(
				`The build's @ngrok/app-server does not use entry protocol ${ENTRY_PROTOCOL}. Install the same version of @ngrok/app-server that the build uses.`,
			);
		}
		return exported;
	}
	const known = plainEntries.get(build);
	if (known != null) {
		return known;
	}
	const { appServerEntry, isServerBuild } = await import("./react-router.js");
	if (!isServerBuild(build)) {
		throw new Error("The server build entry is not a React Router server build.");
	}
	const entry = appServerEntry(build);
	plainEntries.set(build, entry);
	return entry;
}
