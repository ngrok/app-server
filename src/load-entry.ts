import { createServer, serverInternals, type ServerInternals } from "./create-server.js";
import type { FrameworkAdapter, ServerBindings, SetupInfo } from "./types.js";

type AdapterFactory = (build: unknown, options: { mode: SetupInfo["mode"] }) => unknown;

function isAdapterFactory(value: unknown): value is AdapterFactory {
	return typeof value === "function";
}

function isFrameworkAdapter(value: unknown): value is FrameworkAdapter {
	return (
		typeof value === "object" &&
		value != null &&
		"fetch" in value &&
		typeof value.fetch === "function" &&
		"clientDirectory" in value &&
		typeof value.clientDirectory === "string" &&
		"prerenderedPaths" in value &&
		Array.isArray(value.prerenderedPaths)
	);
}

/** A server build entry, as the CLI reads it. */
export type LoadedEntry = {
	framework: FrameworkAdapter;
	internals: ServerInternals;
	/** The app's request handler. */
	fetch: (request: Request, bindings: ServerBindings) => Response | Promise<Response>;
};

type FetchableApp = {
	fetch: (request: Request, bindings: ServerBindings) => Response | Promise<Response>;
};

function isFetchableApp(value: unknown): value is FetchableApp {
	return (
		typeof value === "object" &&
		value != null &&
		"fetch" in value &&
		typeof value.fetch === "function"
	);
}

/**
 * Reads a server build entry. The framework adapter comes from the entry's
 * `appServerAdapter` export when it has one (the `serverEntry` Vite plugin
 * adds it), else from this package's React Router adapter. The app comes from
 * the `app` export, else `fallbackApp`.
 */
export async function loadEntry(
	entry: unknown,
	{ mode, fallbackApp }: { mode: SetupInfo["mode"]; fallbackApp: () => unknown },
): Promise<LoadedEntry> {
	const exports = typeof entry === "object" && entry != null ? entry : {};
	const factory: unknown = Reflect.get(exports, "appServerAdapter");
	let framework: unknown;
	if (isAdapterFactory(factory)) {
		framework = factory(entry, { mode });
	} else {
		const { createAdapter, isServerBuild } = await import("./react-router.js");
		if (!isServerBuild(entry)) {
			throw new Error("The server build entry is not a React Router server build.");
		}
		framework = createAdapter(entry, { mode });
	}
	if (!isFrameworkAdapter(framework)) {
		throw new Error("The `appServerAdapter` export returned no framework adapter.");
	}
	const app: unknown = Reflect.get(exports, "app") ?? fallbackApp();
	const internals = serverInternals(app);
	if (internals == null || !isFetchableApp(app)) {
		throw new Error("The `app` export of the server build is not an app from `createServer()`.");
	}
	return { framework, internals, fetch: (request, bindings) => app.fetch(request, bindings) };
}

/** The app for a build with no `app` export: the default plugins and listener. */
export function defaultApp(): unknown {
	return createServer({ trustForwardedProto: process.env.TRUST_FORWARDED_PROTO === "1" });
}
