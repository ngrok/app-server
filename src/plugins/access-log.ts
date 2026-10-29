import type { Context } from "hono";
import type { AppServerEnv, Plugin } from "../types.js";

/** Options for {@link accessLog}. */
export type AccessLogOptions = {
	/**
	 * Replace each query value with `REDACTED`, so a single-use code in a URL
	 * never reaches a log.
	 * @default true
	 */
	redactQuery?: boolean;
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
	const query = Array.from(url.searchParams.keys())
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
 * attribute names. The line goes out when the body ends or the client
 * disconnects, so a streamed response logs its full duration and size.
 *
 * @example
 * createServer({ plugins: [requestId(), accessLog({ redactQuery: false })] });
 * // {"level":"info","message":"request","http.status_code":200,"network.bytes_written":5120,"duration":1830000,...}
 */
export function accessLog({ redactQuery = true }: AccessLogOptions = {}): Plugin {
	return {
		name: "access-log",
		middleware: async (context, next) => {
			const started = performance.now();
			await next();
			const write = ({ bytes, aborted }: { bytes: number; aborted: boolean }) => {
				context.var.logger.info("request", lineAttributes(context, { bytes, aborted, started }));
			};
			const response = context.res;
			// Why HEAD: Hono drops the body of a HEAD response, so no one reads it to its end.
			if (response.body == null || context.req.method === "HEAD") {
				write({ bytes: 0, aborted: false });
				return;
			}
			const reader = response.body.getReader();
			let bytes = 0;
			const counted = new ReadableStream<Uint8Array>({
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
					write({ bytes, aborted: true });
					await reader.cancel(reason);
				},
			});
			context.res = new Response(counted, response);
		},
	};

	function lineAttributes(
		context: Context<AppServerEnv>,
		{ bytes, aborted, started }: { bytes: number; aborted: boolean; started: number },
	): Record<string, unknown> {
		return {
			"http.url": loggedUrl(new URL(context.req.url), { redact: redactQuery }),
			"http.status_code": context.res.status,
			"http.useragent": context.req.header("User-Agent"),
			"http.referer": loggedReferer(context.req.header("Referer"), { redact: redactQuery }),
			"network.client.ip": context.env.remoteAddress,
			"network.bytes_written": bytes,
			// Why nanoseconds: Datadog's standard `duration` attribute is in nanoseconds.
			duration: Math.round((performance.now() - started) * 1_000_000),
			...(aborted ? { "http.client_aborted": true } : {}),
		};
	}
}
