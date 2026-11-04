import type { Context } from "hono";
import { withHeaderHook } from "../header-hook.js";
import { errorAttributes } from "../log.js";
import { onResponseSent } from "../response-edge.js";
import type { AppServerEnv, Plugin, SentResponse } from "../types.js";

/** Options for {@link accessLog}. */
export type AccessLogOptions = {
	/**
	 * Replace each query value with `REDACTED`, so a single-use code in a URL
	 * never reaches a log.
	 * @default true
	 */
	redactQuery?: boolean;
	/**
	 * More attributes for each request line, such as the app's user ID. Read
	 * the request and the context here, not `c.res`: on Node.js and Vercel it
	 * does not have the changes of the header hooks, and on Bun it has no
	 * headers, because Bun takes them when it sends the response.
	 */
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
 * disconnects, so a streamed response logs its full duration and size. It
 * logs the response that leaves the server, after each stage. A listener
 * with an `edge`, such as the node listener, counts the bytes.
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
	return {
		name: "access-log",
		middleware: async (context, next) => {
			const started = performance.now();
			// Why a hook: it runs when the head is ready, which is the time that the header gives.
			await (serverTiming
				? withHeaderHook(context, next, (headers) => {
						if (headers.get("Content-Type")?.startsWith("text/html") ?? false) {
							headers.append(
								"Server-Timing",
								`app;dur=${(performance.now() - started).toFixed(1)}`,
							);
						}
					})
				: next());
			// Why a catch: a log line must never change the response or stop its stream. The listener can
			// call the report from an event of its socket, where a throw stops the process.
			onResponseSent(context, (sent) => {
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
			});
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
		{ status, bytes, aborted }: SentResponse,
		started: number,
	): Record<string, unknown> {
		const line: Record<string, unknown> = {
			"http.url": requestUrl(context.req.url),
			"http.status_code": status,
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
