import { accepts } from "hono/accepts";
import type { Plugin, SetupInfo } from "../types.js";

const COMPRESSIBLE =
	/^(?:text\/|application\/(?:json|javascript|xml|schema\+json|manifest\+json|x-ndjson|connect\+json)|image\/svg\+xml)/u;

/**
 * Gzips text responses and flushes after each chunk, so a streamed page shell
 * or a server-sent event reaches the client at once. `hono/compress` holds a
 * stream until it ends. Skips a response that is already encoded, a partial
 * response, and one marked `no-transform`. It sets `Vary: Accept-Encoding` on
 * each response. The host gives the gzip stream. On a host with none, the
 * plugin does nothing.
 *
 * @example
 * createServer({ plugins: [requestId(), accessLog(), streamingCompress()] });
 */
export function streamingCompress(): Plugin {
	let gzip: SetupInfo["gzip"];
	return {
		name: "streaming-compress",
		setup: (info) => {
			({ gzip } = info);
		},
		middleware: async (context, next) => {
			await next();
			if (gzip == null) {
				return;
			}
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
			context.res = new Response(gzip(response.body), response);
			// Why after the assignment: Hono copies the old response's headers onto the new one.
			context.res.headers.set("Content-Encoding", "gzip");
			context.res.headers.delete("Content-Length");
		},
	};
}
