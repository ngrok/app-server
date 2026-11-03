import { acceptsGzip, forbidsTransform, isCompressible, MIN_GZIP_BYTES } from "../gzip-rules.js";
import { replaceResponse, writableHeaders } from "../header-hook.js";
import type { Plugin, SetupInfo } from "../types.js";
import { withVary } from "../vary.js";

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
			if (type != null && !isCompressible(type)) {
				return;
			}
			const vary = withVary(context.res.headers.get("Vary"), "Accept-Encoding");
			if (vary != null) {
				writableHeaders(context).set("Vary", vary);
			}
			// Why after the copy: on Bun, the copy takes the body stream of the old response.
			const response = context.res;
			const length = response.headers.get("Content-Length");
			if (
				type == null ||
				response.body == null ||
				context.req.method === "HEAD" ||
				(length != null && Number(length) < MIN_GZIP_BYTES) ||
				!acceptsGzip(context) ||
				response.headers.has("Content-Encoding") ||
				// Why: gzip changes the bytes, so a `Content-Range` would no longer match them.
				response.headers.has("Content-Range") ||
				forbidsTransform(response.headers.get("Cache-Control"))
			) {
				return;
			}
			replaceResponse(context, new Response(gzip(response.body), response));
			context.res.headers.set("Content-Encoding", "gzip");
			context.res.headers.delete("Content-Length");
			// Why: a range of the gzip bytes cannot be served, because each response compresses again.
			context.res.headers.delete("Accept-Ranges");
		},
	};
}
