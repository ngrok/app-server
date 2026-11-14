import { withBuiltInHeaderHook } from "../header-hook.js";
import { checkHeaderName, checkHeaderValue, optionPlugin } from "../plugin-options.js";
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
	/**
	 * The response header that carries the build. Give the same name to
	 * `staleBuildReactRouter()` or `staleBuildTanStack()`. A name that is not
	 * an HTTP header name stops startup.
	 * @default "X-Build-Id"
	 */
	headerName?: string;
	/**
	 * The deployed build, such as the image tag. With no value or `""`, the
	 * plugin sends the ID that the `appServer` Vite plugin derives from the
	 * client build. In development, it then sends no build. A value that a
	 * header cannot hold, such as one with a line break, stops startup.
	 * @default the `buildId` of `.app-server.json` in the client build
	 */
	value?: string | undefined;
	/**
	 * More request paths whose responses carry the build in `Server-Timing`,
	 * such as the app's proxy routes to its API. A tab then finds a new build
	 * in the requests that it already sends. They get no build header, because
	 * the header marks the router's own responses. A response that a cache can
	 * use again without the server gets no build, so a cached copy never
	 * reports an old build. It runs in a header hook, so it can run more than
	 * once for one request.
	 *
	 * @example
	 * buildId({ paths: (path) => path.startsWith("/api/") });
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

/** The metrics of a `Server-Timing` header, such as `build;desc="v42"`. */
export function serverTimingMetrics(header: string | null): string[] {
	// Why match the quoted strings: a comma or an escaped quote in a description does not end a metric.
	return (header?.match(/(?:[^",]|"(?:[^"\\]|\\.)*")+/gu) ?? [])
		.map((metric) => metric.trim())
		.filter((metric) => metric !== "");
}

/** Whether a `Server-Timing` metric is a build. */
export function isBuildMetric(metric: string): boolean {
	return metric.split(";")[0]?.trim().toLowerCase() === BUILD_ID_METRIC;
}

/** The `Server-Timing` metrics of `header` that are not a build. */
function otherMetrics(header: string | null): string[] {
	return serverTimingMetrics(header).filter((metric) => !isBuildMetric(metric));
}

/** The data check before `setup` runs. */
function noDataRequests(): boolean {
	return false;
}

/** A `Server-Timing` quoted string with the characters of `value`. */
function quoted(value: string): string {
	return `"${value.replaceAll(/["\\]/gu, String.raw`\$&`)}"`;
}

/** The `build` metric of `value`, or `undefined` for no build. */
function buildMetric(value: string | undefined): string | undefined {
	return value == null ? undefined : `${BUILD_ID_METRIC};desc=${quoted(value)}`;
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
 * With no `value`, it sends the build ID that the `appServer` Vite plugin
 * derives from the client build. Development and a build with no
 * `.app-server.json` then get no build.
 *
 * @example
 * buildId({ value: process.env.IMAGE_TAG });
 */
export function buildId({
	headerName = BUILD_ID_HEADER,
	value: given,
	paths,
}: BuildIdOptions = {}): Plugin {
	// Why `""` too: a deploy can set the variable with no value, such as `IMAGE_TAG=`.
	const explicit = given === "" ? undefined : given;
	checkHeaderName({ plugin: "buildId", option: "headerName", name: headerName });
	if (explicit != null) {
		checkHeaderValue({ plugin: "buildId", option: "value", value: explicit });
	}
	let value = explicit;
	let timing = buildMetric(value);
	let isDataRequest: SetupInfo["isDataRequest"] = noDataRequests;
	return optionPlugin("buildId", {
		name: "build-id",
		setup: (info) => {
			({ isDataRequest } = info);
			value = explicit ?? info.buildId;
			timing = buildMetric(value);
		},
		// Why: a 304 has no `Content-Type`, so a document that did not change on disk must still
		// answer 200 when the build ID changes.
		etagPart: () => value,
		// oxlint-disable-next-line typescript/promise-function-async -- the server awaits each stage in a `try`, and an `async` stage adds a promise to each request.
		middleware: (context, next) =>
			withBuiltInHeaderHook({
				context,
				next,
				hook: (response) => {
					const { path } = context.req;
					const isRouter =
						(response.get("Content-Type")?.startsWith("text/html") ?? false) || isDataRequest(path);
					const isStamped = isRouter || (paths?.(path) === true && !isReusable(response));
					// Why remove the build of an upstream API: the client must read only this app's build.
					const before = response.get("Server-Timing");
					const stamp = isStamped && timing != null ? timing : "";
					// Why no parse with no header: most responses have none, so they have no metric to keep.
					const metrics =
						before == null
							? stamp
							: [...otherMetrics(before), ...(stamp === "" ? [] : [stamp])].join(", ");
					if (metrics === "") {
						response.delete("Server-Timing");
					} else if (metrics !== before) {
						response.set("Server-Timing", metrics);
					}
					if (isRouter && value != null) {
						response.set(headerName, value);
					} else {
						response.delete(headerName);
					}
				},
			}),
	});
}
