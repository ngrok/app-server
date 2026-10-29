import { createContext, createRequestHandler, RouterContextProvider } from "react-router";
import type { ServerBuild } from "react-router";
import { jsonSink, sinkLogger } from "../core/log.js";
import type { FrameworkRuntime, Mode, RequestContext } from "../core/types.js";

/** What the server puts in React Router's context for each request. */
export type AppServerContext = RequestContext;

/**
 * The React Router context key for {@link AppServerContext}. Outside a server
 * request, such as in React Router's prerender pass, it holds no request ID
 * and a logger that writes to `jsonSink()`. `requestContext()` from
 * `@ngrok/app-server` gives the same values.
 *
 * @example
 * export async function loader({ context }: Route.LoaderArgs) {
 * 	context.get(appServerContext).logger.info("loading the dashboard");
 * }
 */
export const appServerContext = createContext<AppServerContext>({
	requestId: undefined,
	logger: sinkLogger(jsonSink()),
});

/**
 * Whether a module is a React Router server build.
 *
 * @example
 * isServerBuild(await import("./build/server/index.js")); // => true
 */
export function isServerBuild(value: unknown): value is ServerBuild {
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
 * gets a `RouterContextProvider` that holds {@link appServerContext}.
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
	const handler = createRequestHandler(build, mode);
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
		contentTypes: { ".data": "text/x-script" },
		fetch: async (request, context) => {
			const routerContext = new RouterContextProvider();
			routerContext.set(appServerContext, {
				requestId: context.var.requestId,
				logger: context.var.logger,
			});
			return handler(request, routerContext);
		},
	};
}
