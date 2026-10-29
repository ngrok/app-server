import { resolve } from "node:path";
import {
	//,
	createContext,
	createRequestHandler,
	RouterContextProvider,
	type ServerBuild,
} from "react-router";
import { jsonSink, sinkLogger } from "./log.js";
import type { FrameworkAdapter, RequestLogger, SetupInfo } from "./types.js";

/** What the server puts in React Router's context for each request. */
export type AppServerContext = {
	/** The request ID, when the `requestId` plugin runs. */
	requestId: string | undefined;
	/** The request's logger. Its lines carry the request ID. */
	logger: RequestLogger;
};

/**
 * The React Router context key for {@link AppServerContext}. Outside a server
 * request, such as in React Router's prerender pass, it holds no request ID
 * and a logger that writes to `jsonSink()`.
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
 * The framework adapter for a React Router server build. Each request gets a
 * `RouterContextProvider` that holds {@link appServerContext}.
 *
 * @example
 * const framework = createAdapter(build, { mode: "production" });
 */
export function createAdapter(
	build: ServerBuild,
	{ mode }: { mode: SetupInfo["mode"] },
): FrameworkAdapter {
	if (build.publicPath !== "/") {
		throw new Error(
			`@ngrok/app-server serves a build at "/" only, and this build has the publicPath "${build.publicPath}".`,
		);
	}
	const handler = createRequestHandler(build, mode);
	return {
		clientDirectory: resolve(build.assetsBuildDirectory),
		prerenderedPaths: build.prerender,
		fetch: (request, context) => {
			const routerContext = new RouterContextProvider();
			routerContext.set(appServerContext, {
				requestId: context.var.requestId,
				logger: context.var.logger,
			});
			return handler(request, routerContext);
		},
	};
}
