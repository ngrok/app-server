import { withHeaderHook } from "../header-hook.js";
import type { Plugin, SetupInfo } from "../types.js";

/** The header that {@link buildId} sets by default. */
export const BUILD_ID_HEADER = "X-Build-Id";

/**
 * The `Server-Timing` metric that holds the build of a response. Why
 * `Server-Timing`: a script can read it from the performance entries, with no
 * request and no change to the document's HTML.
 */
export const BUILD_ID_METRIC = "build";

/** Options for {@link buildId}. */
export type BuildIdOptions = {
	/** @default "X-Build-Id" */
	header?: string;
	/** The deployed build, such as the image tag. Read it from the runtime env, not the build. */
	value: string;
	/**
	 * More request paths whose responses carry the build, such as the app's
	 * proxy routes to its API. A tab then finds a new build in the requests
	 * that it already sends. A response that a shared cache can keep
	 * (`public` or `s-maxage`) gets no build, so a cached copy never reports
	 * an old build.
	 *
	 * @example
	 * buildId({ value, paths: (path) => path.startsWith("/api/") });
	 */
	paths?: (path: string) => boolean;
};

/** Whether a `Cache-Control` lets a shared cache keep the response. */
function isShared(cacheControl: string | null): boolean {
	return /\b(?:public|s-maxage)\b/iu.test(cacheControl ?? "");
}

/** The data check before `setup` runs. */
function noDataRequests(): boolean {
	return false;
}

/** A `Server-Timing` quoted string with the characters of `value`. */
function quoted(value: string): string {
	return `"${value.replaceAll(/["\\]/gu, String.raw`\$&`)}"`;
}

/**
 * Sets a build ID header on documents and on the framework's data responses,
 * such as React Router `.data` files, so a client can see that a deploy
 * happened under it. The `paths` option adds more routes, such as API
 * proxy routes. Each of them also gets the build as
 * `Server-Timing: build;desc="<value>"`. `staleBuildNavigation()` from
 * `@ngrok/app-server/client` reads it from the document, and from a data
 * response that the browser fetches with no script, such as a prefetch.
 *
 * @example
 * buildId({ value: env.values.PUBLIC_APP_VERSION });
 */
export function buildId({ header = BUILD_ID_HEADER, value, paths }: BuildIdOptions): Plugin {
	const timing = `${BUILD_ID_METRIC};desc=${quoted(value)}`;
	let isDataRequest: SetupInfo["isDataRequest"] = noDataRequests;
	return {
		name: "build-id",
		setup: (info) => {
			({ isDataRequest } = info);
		},
		// Why: a 304 has no `Content-Type`, so a document that did not change on disk must still
		// answer 200 when the build ID changes.
		etagPart: () => value,
		middleware: async (context, next) =>
			withHeaderHook(context, next, (response) => {
				const { path } = context.req;
				const isDocument = response.get("Content-Type")?.startsWith("text/html") ?? false;
				const isPath = paths?.(path) === true && !isShared(response.get("Cache-Control"));
				if (isDocument || isDataRequest(path) || isPath) {
					response.set(header, value);
					response.append("Server-Timing", timing);
				}
			}),
	};
}
