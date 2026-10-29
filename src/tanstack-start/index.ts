import { requestContext } from "../core/request-context.js";
import type { FrameworkRuntime, Mode } from "../core/types.js";

/** The part of a TanStack Start server entry that the adapter calls. */
type StartServerEntry = {
	fetch: (
		request: Request,
		options?: { context?: Record<string, unknown> },
	) => Response | Promise<Response>;
};

/** Whether a module's default export is a TanStack Start server entry. */
function startServerEntry(module: unknown): StartServerEntry | undefined {
	if (typeof module !== "object" || module == null) {
		return undefined;
	}
	const entry: unknown = Reflect.get(module, "default");
	if (typeof entry !== "object" || entry == null || !("fetch" in entry)) {
		return undefined;
	}
	const { fetch } = entry;
	if (typeof fetch !== "function") {
		return undefined;
	}
	return {
		fetch: async (request, options) => {
			const response: unknown = await Reflect.apply(fetch, entry, [request, options]);
			if (!(response instanceof Response)) {
				throw new TypeError("The TanStack Start server entry did not return a Response.");
			}
			return response;
		},
	};
}

/**
 * The run side of the TanStack Start adapter, for the module of Start's
 * server entry. Start reads `{ appServer: requestContext() }` as its request
 * context. The server reads the prerendered paths that the Vite plugin
 * recorded.
 *
 * @example
 * const framework = runtime(await import("virtual:tanstack-start-server-entry"), { mode: "production" });
 */
export function runtime(serverModule: unknown, _info: { mode: Mode }): FrameworkRuntime {
	const entry = startServerEntry(serverModule);
	if (entry == null) {
		throw new Error("The server module has no TanStack Start server entry as its default export.");
	}
	return {
		name: "tanstack-start",
		// Why this prefix: Start answers each server function at `TSS_SERVER_FN_BASE`, `/_serverFn/` by default.
		isDataRequest: (path) => path.startsWith("/_serverFn/"),
		fetch: async (request) => entry.fetch(request, { context: { appServer: requestContext() } }),
	};
}
