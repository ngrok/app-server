import type { Context } from "hono";
import { replaceResponse, writableHeaders } from "../header-hook.js";
import { errorAttributes } from "../log.js";
import type { AppServerEnv, Plugin, SentBody, SetupInfo } from "../types.js";

/** Options for {@link accessLog}. */
export type AccessLogOptions = {
	/**
	 * Replace each query value with `REDACTED`, so a single-use code in a URL
	 * never reaches a log.
	 * @default true
	 */
	redactQuery?: boolean;
	/** More attributes for each request line, such as the app's user ID. */
	attributes?: (context: Context<AppServerEnv>) => Readonly<Record<string, unknown>>;
	/**
	 * Set `Server-Timing: app;dur=<ms>` on each HTML document: the time until
	 * the response headers were ready. The browser's DevTools show it.
	 * @default false
	 */
	serverTiming?: boolean;
};

/**
 * A URL's path and query, with each query value replaced when `redact` is set.
 *
 * @example
 * loggedUrl(new URL("https://example.com/verify?code=123"), { redact: true }); // => "/verify?code=REDACTED"
 */
export function loggedUrl(url: URL, { redact }: { redact: boolean }): string {
	if (!redact || url.search === "") {
		return `${url.pathname}${url.search}`;
	}
	const query = [...url.searchParams.keys()]
		.map((key) => `${encodeURIComponent(key)}=REDACTED`)
		.join("&");
	return `${url.pathname}?${query}`;
}

/** A `Referer` with its query redacted like {@link loggedUrl}. A value that is not a URL is dropped. */
function loggedReferer(referer: string | undefined, { redact }: { redact: boolean }) {
	if (referer == null || !redact) {
		return referer;
	}
	const url = URL.parse(referer);
	return url == null ? undefined : `${url.origin}${loggedUrl(url, { redact })}`;
}

/**
 * One log line per request, static hits included, with Datadog standard
 * attribute names. The line goes out when the response ends or the client
 * disconnects, so a streamed response logs its full duration and size. On a
 * host with `countSent`, such as the node host, the host counts the bytes.
 *
 * @example
 * createServer({ plugins: [requestId(), accessLog({ redactQuery: false })] });
 * // {"level":"info","message":"request","http.status_code":200,"network.bytes_written":5120,"duration":1830000,...}
 */
export function accessLog({
	redactQuery = true,
	attributes,
	serverTiming = false,
}: AccessLogOptions = {}): Plugin {
	let countSent: SetupInfo["countSent"];
	return {
		name: "access-log",
		setup: (info) => {
			({ countSent } = info);
		},
		middleware: async (context, next) => {
			const started = performance.now();
			await next();
			if (
				serverTiming &&
				(context.res.headers.get("Content-Type")?.startsWith("text/html") ?? false)
			) {
				const duration = (performance.now() - started).toFixed(1);
				writableHeaders(context).append("Server-Timing", `app;dur=${duration}`);
			}
			// Why a catch: a log line must never change the response or stop its stream. The host can
			// call `write` from an event of its socket, where a throw stops the process.
			const write = (sent: SentBody) => {
				const line = lineAttributes(context, sent, started);
				try {
					context
						.get("logger")
						.info("request", attributes == null ? line : { ...line, ...attributes(context) });
				} catch (error) {
					try {
						context.get("logger").error("access log attributes failed", {
							...line,
							...errorAttributes(error),
						});
					} catch {
						// Why drop it: the sink failed twice, so no line can go out.
					}
				}
			};
			const response = context.res;
			// Why HEAD: Hono drops the body of a HEAD response, so no one reads it to its end.
			if (context.req.method === "HEAD") {
				write({ bytes: 0, aborted: false });
				return;
			}
			// Why `Content-Length`: a stage that answers through Node's response, such as Vite in
			// development, gives a response with no body and the length it sent.
			if (response.body == null) {
				write({ bytes: Number(response.headers.get("Content-Length") ?? 0), aborted: false });
				return;
			}
			// Why the host first: it counts each chunk as it sends it, so the body needs no stream around it.
			const hostCounts = countSent?.(context.env, ({ bytes, aborted }) => {
				// Why the length: a host can end a response as complete when its body fails before the
				// host sends the head. Only a body shorter than its `Content-Length` shows that failure.
				const length = Number(context.res.headers.get("Content-Length") ?? 0);
				write({ bytes, aborted: aborted || bytes < length });
			});
			if (hostCounts === true) {
				return;
			}
			const reader = response.body.getReader();
			let bytes = 0;
			const counted = new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						let result: ReadableStreamReadResult<Uint8Array>;
						try {
							result = await reader.read();
						} catch (error) {
							// Why here: `cancel` does not run for a stream that failed.
							write({ bytes, aborted: true });
							throw error;
						}
						const { done, value } = result;
						if (done) {
							controller.close();
							write({ bytes, aborted: false });
							return;
						}
						bytes += value.byteLength;
						controller.enqueue(value);
					},
					async cancel(reason) {
						try {
							write({ bytes, aborted: true });
						} finally {
							await reader.cancel(reason);
						}
					},
				},
				// Why 0: a pass-through stream must not read ahead of the client.
				{ highWaterMark: 0 },
			);
			replaceResponse(context, new Response(counted, response));
		},
	};

	/** `href` as {@link loggedUrl} logs it. */
	function requestUrl(href: string): string {
		const start = href.indexOf("/", href.indexOf("//") + 2);
		// Why no parse for a path alone: a request URL is the `href` of a parsed URL, or one that the
		// Node.js listener checked holds no character that a parse changes. So its path is the `pathname`.
		if (start !== -1 && !href.includes("?", start) && !href.includes("#", start)) {
			return href.slice(start);
		}
		return loggedUrl(new URL(href), { redact: redactQuery });
	}

	function lineAttributes(
		context: Context<AppServerEnv>,
		{ bytes, aborted }: SentBody,
		started: number,
	): Record<string, unknown> {
		const line: Record<string, unknown> = {
			"http.url": requestUrl(context.req.url),
			"http.status_code": context.res.status,
			"http.useragent": context.req.header("User-Agent"),
			"http.referer": loggedReferer(context.req.header("Referer"), { redact: redactQuery }),
			"network.client.ip": context.get("clientAddress"),
			"network.bytes_written": bytes,
			// Why nanoseconds: Datadog's standard `duration` attribute is in nanoseconds.
			duration: Math.round((performance.now() - started) * 1_000_000),
		};
		if (aborted) {
			line["http.client_aborted"] = true;
		}
		return line;
	}
}
