import { HTTPException } from "hono/http-exception";
import type { Plugin } from "../types.js";

// Why: GET and HEAD have no body, and the Fetch `Request` constructor rejects the other three.
const NO_BODY_METHODS = new Set(["GET", "HEAD", "CONNECT", "TRACE", "TRACK"]);

/** Options for {@link bodyLimit}. */
export type BodyLimitOptions = {
	/** The largest request body, in bytes. */
	maxBytes: number;
};

/** The 413 response. */
function tooLarge(): Response {
	return new Response("Payload Too Large", { status: 413 });
}

/**
 * Sends a 413 for a request body that is larger than `maxBytes`. A request
 * whose `Content-Length` is too large gets the 413 before the app reads the
 * body, and a request whose `Content-Length` fits goes on unchanged. A
 * streamed body with no `Content-Length` errors when it passes the limit. When the app reads the body before it answers, the response
 * becomes a 413. When the app streams the body into its response, the
 * response stream errors. A `maxBytes` that is not a whole number of 0 or
 * more stops startup.
 *
 * Why not `hono/body-limit`: it reads a streamed body into memory before the
 * next stage runs, so an upload cannot stream.
 *
 * @example
 * createServer({ plugins: [requestId(), accessLog(), bodyLimit({ maxBytes: 1_048_576 })] });
 */
export function bodyLimit({ maxBytes }: BodyLimitOptions): Plugin {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError(`bodyLimit needs a maxBytes of 0 or more whole bytes, not ${maxBytes}.`);
	}
	return {
		name: "body-limit",
		middleware: async (context, next) => {
			const { raw } = context.req;
			if (NO_BODY_METHODS.has(raw.method)) {
				return next();
			}
			const length = context.req.header("Content-Length");
			// Why no stream count: the host's HTTP parser ends the body at its `Content-Length`. The
			// original request also keeps the fast body reads of `@hono/node-server`.
			if (
				length != null &&
				/^\d+$/u.test(length) &&
				context.req.header("Transfer-Encoding") == null
			) {
				return Number(length) > maxBytes ? tooLarge() : next();
			}
			let bytes = 0;
			let exceeded = false;
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			const limited = new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						// Why on the first read: on Node, `raw.body` starts to read the socket, and a dev
						// server middleware that answers the request reads it there.
						reader ??= raw.body?.getReader();
						const chunk = await reader?.read();
						if (chunk == null || chunk.done) {
							controller.close();
							return;
						}
						bytes += chunk.value.byteLength;
						if (bytes > maxBytes) {
							exceeded = true;
							// Why an `HTTPException`: `onError` sends its 413 and logs no error.
							controller.error(
								new HTTPException(413, {
									message: "The request body is larger than the body limit.",
								}),
							);
							await reader?.cancel();
							return;
						}
						controller.enqueue(chunk.value);
					},
					// Why `raw.body`: if the app cancels before its first read, no reader exists yet.
					cancel: async (reason) => (reader ?? raw.body)?.cancel(reason),
				},
				// Why 0: the stream reads nothing until the app reads it.
				{ highWaterMark: 0 },
			);
			// Why a new request from its parts: `new Request(raw)` reads `raw.body` on Node. `duplex`: a
			// request with a stream body needs it, and the DOM types lack it.
			const init: RequestInit & { duplex: "half" } = {
				method: raw.method,
				headers: raw.headers,
				signal: raw.signal,
				body: limited,
				duplex: "half",
			};
			context.req.raw = new Request(raw.url, init);
			await next();
			if (exceeded) {
				await context.res.body?.cancel();
				// Why clear it first: Hono copies the headers of the old response, such as its length, onto a new one.
				context.res = undefined;
				context.res = tooLarge();
			}
		},
	};
}
