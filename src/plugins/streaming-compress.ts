import { constants, createGzip } from "node:zlib";
import type { Plugin } from "../types.js";

const COMPRESSIBLE =
	/^(text\/|application\/(json|javascript|xml|schema\+json|manifest\+json|x-ndjson|connect\+json)|image\/svg\+xml)/;

/** Gzips a byte stream. `Z_SYNC_FLUSH` makes each written chunk readable at once. */
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
			const pump = async () => {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) {
						gzip.end();
						return;
					}
					gzip.write(value);
				}
			};
			pump().catch((error: unknown) => {
				gzip.destroy(error instanceof Error ? error : new Error("Read failed", { cause: error }));
			});
		},
		// Why cancel the source: a client disconnect must reach the handler, so it stops its work.
		cancel(reason) {
			gzip.destroy();
			return reader.cancel(reason);
		},
	});
}

/**
 * Gzips text responses and flushes after each chunk, so a streamed page shell
 * or a server-sent event reaches the client at once. `hono/compress` holds a
 * stream until it ends. Skips a response that is already encoded or marked
 * `no-transform`, and always sets `Vary: Accept-Encoding`.
 *
 * @example
 * createServer({ plugins: [requestId(), accessLog(), streamingCompress()] });
 */
export function streamingCompress(): Plugin {
	return {
		name: "streaming-compress",
		middleware: async (context, next) => {
			await next();
			const response = context.res;
			response.headers.append("Vary", "Accept-Encoding");
			if (
				response.body == null ||
				context.req.method === "HEAD" ||
				!/\bgzip\b/.test(context.req.header("Accept-Encoding") ?? "") ||
				response.headers.has("Content-Encoding") ||
				/\bno-transform\b/.test(response.headers.get("Cache-Control") ?? "") ||
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
