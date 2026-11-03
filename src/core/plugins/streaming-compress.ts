import { accepts } from "hono/accepts";
import type { Plugin, SetupInfo } from "../types.js";
import { withVary } from "../vary.js";

const COMPRESSIBLE =
	/^(?:text\/|application\/(?:json|javascript|xml|schema\+json|manifest\+json|x-ndjson|connect\+json)|image\/svg\+xml)/u;

/**
 * The smallest body, by `Content-Length`, that the plugin gzips. Why: gzip
 * makes a smaller body larger, and each gzip stream allocates about 300 kibibytes
 * (KiB) of zlib state. `hono/compress` uses the same value.
 */
const MIN_BYTES = 1024;

/**
 * Gzips text responses and flushes after each chunk, so a streamed page shell
 * or a server-sent event reaches the client at once. `hono/compress` holds a
 * stream until it ends. Skips a response that is already encoded, a partial
 * response, one marked `no-transform`, and one whose `Content-Length` is
 * under 1 KiB. It adds `Accept-Encoding` to the `Vary` of each response that
 * it can gzip. The host gives the gzip stream. On a host with none, the
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
			const type = context.res.headers.get("Content-Type");
			// Why: the bytes of a type that the plugin never gzips, such as an image, do not vary by
			// `Accept-Encoding`. A response with no type, such as a 304, keeps the `Vary` of its 200.
			if (type != null && !COMPRESSIBLE.test(type)) {
				return;
			}
			const vary = withVary(context.res.headers.get("Vary"), "Accept-Encoding");
			if (vary != null) {
				// Why `context.header`: it copies a response whose headers are immutable, such as one from `fetch`.
				context.header("Vary", vary);
			}
			// Why after the copy: on Bun, the copy takes the body stream of the old response.
			const response = context.res;
			const length = response.headers.get("Content-Length");
			if (
				type == null ||
				response.body == null ||
				context.req.method === "HEAD" ||
				(length != null && Number(length) < MIN_BYTES) ||
				accepts(context, { header: "Accept-Encoding", supports: ["gzip"], default: "identity" }) !==
					"gzip" ||
				response.headers.has("Content-Encoding") ||
				// Why: gzip changes the bytes, so a `Content-Range` would no longer match them.
				response.headers.has("Content-Range") ||
				/\bno-transform\b/u.test(response.headers.get("Cache-Control") ?? "")
			) {
				return;
			}
			context.res = new Response(gzip(response.body), response);
			// Why after the assignment: Hono copies the old response's headers onto the new one.
			context.res.headers.set("Content-Encoding", "gzip");
			context.res.headers.delete("Content-Length");
			// Why: a range of the gzip bytes cannot be served, because each response compresses again.
			context.res.headers.delete("Accept-Ranges");
		},
	};
}
