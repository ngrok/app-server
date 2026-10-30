import { withHeaderHook } from "../header-hook.js";
import type { Plugin, ResponseHeaders, SetupInfo } from "../types.js";

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
	 * More request paths whose responses carry the build in `Server-Timing`,
	 * such as the app's proxy routes to its API. A tab then finds a new build
	 * in the requests that it already sends. They get no build header, because
	 * the header marks the router's own responses. A response that a cache can
	 * use again without the server gets no build, so a cached copy never
	 * reports an old build.
	 *
	 * @example
	 * buildId({ value, paths: (path) => path.startsWith("/api/") });
	 */
	paths?: (path: string) => boolean;
};

/**
 * Whether a cache can use the response again without the server: it has a
 * fresh time, a stale time, or a date that a cache can guess a fresh time from.
 */
function isReusable(response: ResponseHeaders): boolean {
	const cacheControl = response.get("Cache-Control") ?? "";
	if (/\b(?:no-store|no-cache)\b/iu.test(cacheControl)) {
		return false;
	}
	return (
		/\b(?:max-age|s-maxage|stale-while-revalidate|stale-if-error)\s*=\s*"?0*[1-9]/iu.test(
			cacheControl,
		) ||
		/\bpublic\b/iu.test(cacheControl) ||
		Date.parse(response.get("Expires") ?? "") > Date.now() ||
		response.has("Last-Modified")
	);
}

/** The `Server-Timing` metrics of `header` that are not a build. */
function otherMetrics(header: string | null): string[] {
	// Why match the quoted strings: a comma or an escaped quote in a description does not end a metric.
	return (header?.match(/(?:[^",]|"(?:[^"\\]|\\.)*")+/gu) ?? [])
		.map((metric) => metric.trim())
		.filter(
			(metric) => metric !== "" && metric.split(";")[0]?.trim().toLowerCase() !== BUILD_ID_METRIC,
		);
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
 * happened under it. Each of them also gets the build as
 * `Server-Timing: build;desc="<value>"`. The `paths` option adds the metric
 * to more routes, such as API proxy routes. The plugin removes the build
 * header and the `build` metric of an upstream API from each other
 * response, so the client reads only this app's build.
 * `staleBuildReactRouter()` and `staleBuildTanStack()` from `@ngrok/app-server/client` read the metric
 * from the document, and from a response that the browser fetches with no
 * script, such as a prefetch.
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
				const isRouter =
					(response.get("Content-Type")?.startsWith("text/html") ?? false) || isDataRequest(path);
				const isStamped = isRouter || (paths?.(path) === true && !isReusable(response));
				// Why remove the build of an upstream API: the client must read only this app's build.
				const before = response.get("Server-Timing");
				const metrics = [...otherMetrics(before), ...(isStamped ? [timing] : [])].join(", ");
				if (metrics === "") {
					response.delete("Server-Timing");
				} else if (metrics !== before) {
					response.set("Server-Timing", metrics);
				}
				if (isRouter) {
					response.set(header, value);
				} else {
					response.delete(header);
				}
			}),
	};
}
