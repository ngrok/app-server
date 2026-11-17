import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { withBuiltInHeaderHook } from "../header-hook.js";
import { isPageRequest } from "../page-request.js";
import type { AppServerEnv, HeaderHook, Plugin } from "../types.js";
import { withVary } from "../vary.js";

/** Options for `cors()`, the CORS middleware of Hono. */
export type CORSOptions = NonNullable<Parameters<typeof cors>[0]>;

/** Options for {@link protocolRoute}. */
export type ProtocolRouteOptions = {
	/**
	 * The URL path of the endpoint and of the page, such as `/mcp`. It must
	 * start with `/`. A request matches only this exact path.
	 */
	path: string;
	/** Answers each request at `path` that is not a page request. */
	handle: (request: Request) => Response | Promise<Response>;
	/**
	 * The CORS options of the answers of `handle`, as `cors()` from
	 * `@ngrok/app-server` takes them. With them, an `OPTIONS` request gets the
	 * CORS answer and does not reach `handle`. Without them, the answers get no
	 * CORS headers.
	 */
	cors?: CORSOptions;
};

/** Adds `Accept` to `Vary`. Why: the `Accept` of a `GET` picks the page or the endpoint. */
const varyOnAccept: HeaderHook = (headers) => {
	const vary = withVary(headers.get("Vary"), "Accept");
	if (vary != null) {
		headers.set("Vary", vary);
	}
};

/** Goes on to the next stage. Why: a route with no `cors` option runs no CORS stage. */
const noCors: MiddlewareHandler<AppServerEnv> = async (_context, next) => next();

/**
 * Serves a protocol endpoint and a page at one URL, such as `/mcp` for MCP
 * clients and for a browser. A page request, as {@link isPageRequest} decides
 * it, goes on to the framework. Each other request at `path` goes to `handle`,
 * with the CORS headers of `cors`. A `GET` and a `HEAD` at `path` get
 * `Vary: Accept` on both answers, so a shared cache keeps them apart.
 *
 * Put it in `beforeStatic`, so a prerendered page at `path` also gets
 * `Vary: Accept`. A framework data request, such as `/mcp.data`, has another
 * path, so it goes to the framework.
 *
 * A `path` that does not start with `/`, or that has a `?` or a `#`, stops
 * startup.
 *
 * @example
 * createServer({
 * 	plugins: defaultPlugins({
 * 		beforeStatic: [protocolRoute({ path: "/mcp", handle: (request) => handler.fetch(request), cors: { origin: "*" } })],
 * 	}),
 * });
 */
export function protocolRoute({ path, handle, cors: corsOptions }: ProtocolRouteOptions): Plugin {
	if (!path.startsWith("/")) {
		throw new Error(
			`protocolRoute needs a path that starts with "/", not ${JSON.stringify(path)}.`,
		);
	}
	// Why: the request path has no query and no fragment, so no request could match.
	if (/[?#]/u.test(path)) {
		throw new Error(
			`protocolRoute needs a path with no "?" and no "#", not ${JSON.stringify(path)}. It matches the path of the request only.`,
		);
	}
	const withCors: MiddlewareHandler<AppServerEnv> =
		corsOptions == null ? noCors : cors(corsOptions);
	/** Sends the request to `handle`, with CORS. The CORS answer of a preflight replaces it. */
	const toHandler = async (context: Context<AppServerEnv, string>) => {
		const preflight = await withCors(context, async () => {
			context.res = await handle(context.req.raw);
		});
		if (preflight != null) {
			context.res = preflight;
		}
	};
	return {
		name: "protocol-route",
		middleware: async (context, next) => {
			if (context.req.path !== path) {
				return next();
			}
			const answer = isPageRequest(context.req.raw) ? next : async () => toHandler(context);
			const { method } = context.req;
			return method === "GET" || method === "HEAD"
				? withBuiltInHeaderHook({ context, next: answer, hook: varyOnAccept })
				: answer();
		},
	};
}
