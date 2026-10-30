import { withHeaderHook } from "../header-hook.js";
import type { Plugin, SetupInfo } from "../types.js";

/** The header that {@link buildId} sets by default. */
export const BUILD_ID_HEADER = "X-Build-Id";

/**
 * The `Server-Timing` metric that holds the build of a document. Why
 * `Server-Timing`: a script can read it from the navigation entry, and the
 * document's HTML does not change.
 */
export const BUILD_ID_METRIC = "build";

/** Options for {@link buildId}. */
export type BuildIdOptions = {
	/** @default "X-Build-Id" */
	header?: string;
	/** The deployed build, such as the image tag. Read it from the runtime env, not the build. */
	value: string;
};

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
 * happened under it. Each of them also gets the build as
 * `Server-Timing: build;desc="<value>"`. `staleBuildNavigation()` from
 * `@ngrok/app-server/client` reads it from the document, and from a data
 * response that the browser fetches with no script, such as a prefetch.
 *
 * @example
 * buildId({ value: env.values.PUBLIC_APP_VERSION });
 */
export function buildId({ header = BUILD_ID_HEADER, value }: BuildIdOptions): Plugin {
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
				const isDocument = response.get("Content-Type")?.startsWith("text/html") ?? false;
				if (isDocument || isDataRequest(context.req.path)) {
					response.set(header, value);
					response.append("Server-Timing", timing);
				}
			}),
	};
}
