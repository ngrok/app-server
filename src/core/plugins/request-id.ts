import { withHeaderHook } from "../header-hook.js";
import { checkHeaderName, optionPlugin } from "../plugin-options.js";
import type { Plugin } from "../types.js";

/** Options for {@link requestId}. */
export type RequestIdOptions = {
	/**
	 * The request header that the ID comes from, and the response header that
	 * carries it. A name that is not an HTTP header name stops startup.
	 * @default "X-Request-Id"
	 */
	headerName?: string;
	/**
	 * Also log the trace IDs as `dd.trace_id` and `dd.span_id`, the lower 64
	 * bits in decimal, so Datadog connects each log line to its trace.
	 * @default false
	 */
	datadogTraceIds?: boolean;
};

/** An incoming request ID that the plugin keeps: up to 255 word characters, `-`, and `=`. */
const VALID_ID = /^[\w\-=]{1,255}$/u;

/** A W3C `traceparent`: version, trace ID, parent ID, and flags, in lowercase hex. */
const TRACEPARENT =
	/^(?<version>[\da-f]{2})-(?<traceId>[\da-f]{32})-(?<spanId>[\da-f]{16})-[\da-f]{2}(?<rest>-.*)?$/u;

/**
 * The trace IDs of a valid W3C `traceparent` header, else `undefined`. A
 * version `ff`, an ID of all zeros, and extra fields in version `00` are not valid.
 *
 * @example
 * parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
 * // => { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" }
 */
export function parseTraceparent(
	header: string | undefined,
): { traceId: string; spanId: string } | undefined {
	const groups = TRACEPARENT.exec(header?.trim() ?? "")?.groups;
	if (
		groups?.version == null ||
		groups.traceId == null ||
		groups.spanId == null ||
		groups.version === "ff" ||
		(groups.version === "00" && groups.rest != null) ||
		/^0+$/u.test(groups.traceId) ||
		/^0+$/u.test(groups.spanId)
	) {
		return undefined;
	}
	return { traceId: groups.traceId, spanId: groups.spanId };
}

/** The log attributes for the trace IDs. */
function traceAttributes(
	{ traceId, spanId }: { traceId: string; spanId: string },
	{ datadog }: { datadog: boolean },
): Record<string, string> {
	return {
		trace_id: traceId,
		span_id: spanId,
		...(datadog
			? {
					"dd.trace_id": BigInt(`0x${traceId.slice(16)}`).toString(),
					"dd.span_id": BigInt(`0x${spanId}`).toString(),
				}
			: {}),
	};
}

/**
 * Gives each request an ID: a valid incoming header (up to 255 word
 * characters, `-`, and `=`), else a new UUID. The ID goes on the response, on
 * every log line, and into the framework's context. A request of the build's
 * check of the CDN pages gets no ID on the response.
 *
 * A valid W3C `traceparent` header adds `trace_id` and `span_id` to each log
 * line of the request.
 *
 * @example
 * const app = createServer({ plugins: [requestId()] });
 * const response = await app.request("/", { headers: { "X-Request-Id": "abc-123" } });
 * response.headers.get("X-Request-Id"); // => "abc-123"
 */
export function requestId({
	headerName = "X-Request-Id",
	datadogTraceIds = false,
}: RequestIdOptions = {}): Plugin {
	checkHeaderName({ plugin: "requestId", option: "headerName", name: headerName });
	return optionPlugin("requestId", {
		name: "request-id",
		// oxlint-disable-next-line typescript/promise-function-async -- the server awaits each stage in a `try`, and an `async` stage adds a promise to each request.
		middleware: (context, next) => {
			const trace = parseTraceparent(context.req.header("traceparent"));
			if (trace != null) {
				context.set("logAttributes", {
					...context.get("logAttributes"),
					...traceAttributes(trace, { datadog: datadogTraceIds }),
				});
			}
			const incoming = context.req.header(headerName);
			const id = incoming != null && VALID_ID.test(incoming) ? incoming : crypto.randomUUID();
			context.set("requestId", id);
			// Why no header for the build's check of the CDN pages: a CDN answer has no request ID, and
			// the check keeps a page in the function when a header changes with each request.
			if (context.env?.onServedFile != null) {
				return next();
			}
			// Why a header hook: a dev server middleware sends its own response, and runs the hooks first.
			return withHeaderHook(context, next, (headers) => {
				headers.set(headerName, id);
			});
		},
	});
}
