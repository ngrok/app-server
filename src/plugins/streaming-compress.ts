import { accepts } from "hono/accepts";
import { constants, createGzip } from "node:zlib";
import type { Plugin } from "../types.js";

const COMPRESSIBLE =
	/^(?:text\/|application\/(?:json|javascript|xml|schema\+json|manifest\+json|x-ndjson|connect\+json)|image\/svg\+xml)/u;

/**
 * Gzips a byte stream. `Z_SYNC_FLUSH` makes each written chunk readable at
 * once. It reads the next source chunk only when the consumer pulls, so a slow
 * client holds back the source.
 */
function gzipStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH });
	const reader = source.getReader();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			gzip.on("data", (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk));
			});
			gzip.on("end", () => {
				controller.close();
			});
			gzip.on("error", (error) => {
				controller.error(error);
			});
		},
		async pull() {
			try {
				let chunk = await reader.read();
				// Why skip empty chunks: gzip writes nothing for one, and a pull that enqueues nothing
				// is not called again.
				while (!chunk.done && chunk.value.byteLength === 0) {
					chunk = await reader.read();
				}
				if (chunk.done) {
					gzip.end();
					return;
				}
				const { value } = chunk;
				await new Promise<void>((resolve, reject) => {
					gzip.write(value, (error) => {
						if (error == null) {
							resolve();
						} else {
							reject(error);
						}
					});
				});
			} catch (error) {
				gzip.destroy();
				throw error;
			}
		},
		// Why cancel the source: a client disconnect must reach the handler, so it stops its work.
		async cancel(reason) {
			gzip.destroy();
			return reader.cancel(reason);
		},
	});
}

/**
 * Gzips text responses and flushes after each chunk, so a streamed page shell
 * or a server-sent event reaches the client at once. `hono/compress` holds a
 * stream until it ends. Skips a response that is already encoded, a partial
 * response, and one marked `no-transform`. Always sets `Vary: Accept-Encoding`.
 *
 * @example
 * createServer({ plugins: [requestId(), accessLog(), streamingCompress()] });
 */
export function streamingCompress(): Plugin {
	return {
		name: "streaming-compress",
		middleware: async (context, next) => {
			await next();
			// Why `context.header`: it copies a response whose headers are immutable, such as one from `fetch`.
			context.header("Vary", "Accept-Encoding", { append: true });
			const response = context.res;
			if (
				response.body == null ||
				context.req.method === "HEAD" ||
				accepts(context, { header: "Accept-Encoding", supports: ["gzip"], default: "identity" }) !==
					"gzip" ||
				response.headers.has("Content-Encoding") ||
				// Why: gzip changes the bytes, so a `Content-Range` would no longer match them.
				response.headers.has("Content-Range") ||
				/\bno-transform\b/u.test(response.headers.get("Cache-Control") ?? "") ||
				!COMPRESSIBLE.test(response.headers.get("Content-Type") ?? "")
			) {
				return;
			}
			context.res = new Response(gzipStream(response.body), response);
			// Why after the assignment: Hono copies the old response's headers onto the new one.
			context.res.headers.set("Content-Encoding", "gzip");
			context.res.headers.delete("Content-Length");
		},
	};
}
