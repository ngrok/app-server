import type { AnyRouter, RegisteredRouter } from "@tanstack/react-router";
import type { TrailingSlash } from "../core/plugins/trailing-slash.js";
import type { FrameworkRuntime, Mode } from "../core/types.js";

/**
 * The `trailingSlash` mode of a TanStack router: the app's registered router
 * by default. A router with no `trailingSlash` has the mode `never`. With no
 * registered router, it is every mode.
 *
 * Use it with `satisfies` on the server's mode. TypeScript then fails when the
 * two modes differ, because different modes make the redirects loop.
 *
 * @example
 * createServer({ plugins: defaultPlugins({ trailingSlash: "never" satisfies RouterTrailingSlash }) });
 */
export type RouterTrailingSlash<TRouter extends AnyRouter = RegisteredRouter> = ModeOf<
	TRouter["options"]["trailingSlash"]
>;

/** A router's `trailingSlash` type as a mode. Why the `any` test: `AnyRouter` has an `any` mode, and a conditional type makes `never` of it. */
type ModeOf<TOption> = 0 extends 1 & TOption
	? TrailingSlash
	: NonNullable<TOption> extends infer TMode extends TrailingSlash
		? TMode
		: TrailingSlash;

/** The prefix of Start's server functions when the config sets none. */
const DEFAULT_SERVER_FN_BASE = "/_serverFn/";

/** The part of a TanStack Start server entry that the adapter calls. */
type StartServerEntry = {
	fetch: (
		request: Request,
		options?: { context?: Record<string, unknown> },
	) => Response | Promise<Response>;
};

/**
 * Whether a value is a `Response`. Why not only `instanceof`: on Node, the
 * listener replaces the global `Response`, but `fetch()` still returns the
 * original type.
 */
function isResponse(value: unknown): value is Response {
	return value instanceof Response || Object.prototype.toString.call(value) === "[object Response]";
}

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
			if (!isResponse(response)) {
				throw new TypeError("The TanStack Start server entry did not return a Response.");
			}
			return response;
		},
	};
}

/**
 * The run side of the TanStack Start adapter, for the module of Start's
 * server entry. Start gets the request ID and logger as `appServer` in its
 * request context. The server reads the prerendered paths that the Vite plugin
 * recorded.
 *
 * @param info.serverFnBase - The prefix of Start's server functions, `TSS_SERVER_FN_BASE`. The entry that the Vite plugin generates sets it.
 *
 * @example
 * const framework = runtime(await import("virtual:tanstack-start-server-entry"), { mode: "production" });
 */
export function runtime(
	serverModule: unknown,
	{ serverFnBase = DEFAULT_SERVER_FN_BASE }: { mode: Mode; serverFnBase?: string },
): FrameworkRuntime {
	const entry = startServerEntry(serverModule);
	if (entry == null) {
		throw new Error("The server module has no TanStack Start server entry as its default export.");
	}
	return {
		name: "tanstack-start",
		isDataRequest: (path) => path.startsWith(serverFnBase),
		fetch: async (request, context) =>
			entry.fetch(request, {
				context: {
					appServer: { requestId: context.var.requestId, logger: context.var.logger },
				},
			}),
	};
}
