import type { Context } from "hono";
import {
	createContext,
	createRequestHandler,
	isRouteErrorResponse,
	RouterContextProvider,
} from "react-router";
import type { HandleErrorFunction, MiddlewareFunction, ServerBuild } from "react-router";
import { asError } from "../core/log.js";
import { outsideLogger, requestContextValues } from "../core/request-context.js";
import type { AppServerEnv, FrameworkRuntime, Mode, RequestContext } from "../core/types.js";
import { CONTENT_TYPES } from "./content-types.js";

/**
 * The React Router context key for the `RequestContext` that the server sets
 * for each request. Outside a server request, such as in React Router's
 * prerender pass, it holds no request ID and the logger that `logger()` gives
 * there. `requestContext()` from `@ngrok/app-server` gives the same values.
 *
 * @example
 * export async function loader({ context }: Route.LoaderArgs) {
 * 	context.get(appServerContext).logger.info("loading the dashboard");
 * }
 */
export const appServerContext = createContext<RequestContext>({
	requestId: undefined,
	logger: outsideLogger,
	cspNonce: undefined,
	clientAddress: undefined,
});

/** The Hono context of the request, for {@link recordRoutePattern}. */
const honoContext = createContext<Context<AppServerEnv>>();

/**
 * Sets `routePattern` on the Hono context to the route pattern that React
 * Router matched, such as `/domains/:domainId`, so the access log writes
 * `http.route`. Why a root middleware: it runs for each document, data, and
 * resource request, and it costs less for each request than a request
 * handler instrumentation.
 */
const recordRoutePattern: MiddlewareFunction<Response> = async ({ pattern, context }, next) => {
	if (pattern !== "") {
		// Why the slash: React Router joins the relative paths of the routes, such as `domains/:domainId`.
		context.get(honoContext).set("routePattern", pattern.startsWith("/") ? pattern : `/${pattern}`);
	}
	return next();
};

/** `build` with {@link recordRoutePattern} before the middleware of each root route. */
function withRoutePattern(build: ServerBuild): ServerBuild {
	const routes = Object.fromEntries(
		Object.entries(build.routes).map(([id, route]) => [
			id,
			route == null || route.parentId != null
				? route
				: {
						...route,
						module: {
							...route.module,
							middleware: [recordRoutePattern, ...(route.module.middleware ?? [])],
						},
					},
		]),
	);
	return { ...build, routes };
}

/**
 * `build` with a `handleError` that adds each error that React Router caught
 * in a loader, an action, or a render to `frameworkErrors` on the Hono
 * context, so the `errors` plugin gets it. The plugin reads the status, and reports a
 * 5xx only. Then it does what the app's `handleError` does, or what React
 * Router does with none: it writes the error to the console unless the client
 * left.
 */
function withFrameworkErrors(build: ServerBuild): ServerBuild {
	const handleError: HandleErrorFunction =
		build.entry.module.handleError ??
		((error, { request }) => {
			if (!request.signal.aborted) {
				// oxlint-disable-next-line no-console -- React Router writes the error to the console when the app has no `handleError`.
				console.error(isRouteErrorResponse(error) && "error" in error ? error.error : error);
			}
		});
	return {
		...build,
		entry: {
			...build.entry,
			module: {
				...build.entry.module,
				handleError: (error, args) => {
					// Why unwrap: React Router gives its own errors in an error response, such as a 404 for a
					// path that no route matches. Why not each error response: a thrown `data()` has no error.
					const isResponse = isRouteErrorResponse(error);
					const thrown: unknown = isResponse && "error" in error ? error.error : error;
					if ((!isResponse || thrown != null) && args.context instanceof RouterContextProvider) {
						const context = args.context.get(honoContext);
						context.set("frameworkErrors", [
							...(context.get("frameworkErrors") ?? []),
							asError(thrown),
						]);
					}
					handleError(error, args);
				},
			},
		},
	};
}

/** Whether a module is a React Router server build. */
function isServerBuild(value: unknown): value is ServerBuild {
	return (
		typeof value === "object" &&
		value != null &&
		"routes" in value &&
		"entry" in value &&
		"assetsBuildDirectory" in value &&
		typeof value.assetsBuildDirectory === "string"
	);
}

/**
 * The run side of the React Router adapter, for a server build. Each request
 * gets a `RouterContextProvider` that holds {@link appServerContext}. The
 * access log gets the route pattern that React Router matched.
 *
 * @example
 * const framework = runtime(build, { mode: "production" });
 */
export function runtime(build: unknown, { mode }: { mode: Mode }): FrameworkRuntime {
	if (!isServerBuild(build)) {
		throw new Error("The server module is not a React Router server build.");
	}
	// Why also here: the Vite plugin checks the base, but a plain build skips the plugin.
	if (build.publicPath !== "/") {
		throw new Error(
			`@ngrok/app-server serves a build at "/" only, and this build has the publicPath "${build.publicPath}".`,
		);
	}
	const handler = createRequestHandler(withFrameworkErrors(withRoutePattern(build)), mode);
	// Why: lazy route discovery fetches this exact path, so a redirect breaks it.
	const manifestPath =
		build.routeDiscovery.mode === "lazy"
			? [build.basename ?? "", build.routeDiscovery.manifestPath || "/__manifest"]
					.join("/")
					.replaceAll(/\/+/gu, "/")
			: undefined;
	return {
		name: "react-router",
		clientDirectory: build.assetsBuildDirectory,
		prerenderedPaths: build.prerender,
		isDataRequest: (path) => path.endsWith(".data") || path === manifestPath,
		contentTypes: CONTENT_TYPES,
		fetch: async (request, context) => {
			const routerContext = new RouterContextProvider();
			routerContext.set(appServerContext, requestContextValues(context));
			routerContext.set(honoContext, context);
			return handler(request, routerContext);
		},
	};
}
