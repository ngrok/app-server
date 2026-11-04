import {
	forbidsTransform,
	isCompressible,
	MIN_COMPRESS_BYTES,
	preferredEncoding,
	readIfQueued,
} from "../compression.js";
import type { ReadResult } from "../compression.js";
import { hookedHeaders, replaceResponse, withHeaderHook } from "../header-hook.js";
import type { Plugin, SetupInfo } from "../types.js";
import { withVary } from "../vary.js";

/** The chunks that a body has queued, and the read that is still open, if any. */
type Queued = { chunks: Uint8Array[]; done: boolean; pending: Promise<ReadResult> | undefined };

/**
 * The most bytes that one pull of {@link replay} joins. Why 16 KiB: a source
 * that makes a chunk on each read looks queued, so the join can read ahead of
 * the client by this size, the default read-ahead of a Node.js stream.
 */
export const MAX_JOINED_BYTES = 16 * 1024;

/**
 * Reads at most two chunks that `reader` has queued, and never waits for
 * more. Why two: a body from a string or a buffer queues its bytes and its
 * end, so the plugin can see that it is small. `@hono/node-server` reads a
 * body the same way to find its length.
 */
async function readQueued(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Queued> {
	const chunks: Uint8Array[] = [];
	for (let count = 0; count < 2; count += 1) {
		const next = await readIfQueued(reader);
		if ("pending" in next) {
			return { chunks, done: false, pending: next.pending };
		}
		if (next.result.done) {
			return { chunks, done: true, pending: undefined };
		}
		chunks.push(next.result.value);
	}
	return { chunks, done: false, pending: undefined };
}

function join(chunks: Uint8Array[], size: number): Uint8Array {
	const [first] = chunks;
	if (chunks.length === 1 && first != null) {
		return first;
	}
	const joined = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return joined;
}

/**
 * The body again: the queued chunks, then the rest of `reader`. Each pull
 * waits for one chunk at most, and joins it with the chunks that are queued
 * after it, up to {@link MAX_JOINED_BYTES}. Why join: gzip flushes after each
 * chunk, and each flush costs more than the bytes. A renderer such as React
 * queues many small chunks at once. A chunk that comes later still goes out on
 * its own. A chunk that does not fit waits for the next pull, and an empty
 * chunk ends the join. When `queued` has the end, the first pull sends the
 * chunks and closes.
 */
function replay(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	queued: Queued,
): ReadableStream<Uint8Array> {
	const chunks = [...queued.chunks];
	let { pending, done } = queued;
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				const parts: Uint8Array[] = [];
				let size = 0;
				const fits = (chunk: Uint8Array) =>
					parts.length === 0 || size + chunk.byteLength <= MAX_JOINED_BYTES;
				for (let [chunk] = chunks; chunk != null && fits(chunk); [chunk] = chunks) {
					chunks.shift();
					parts.push(chunk);
					size += chunk.byteLength;
				}
				if (parts.length === 0) {
					const result = await (pending ?? reader.read());
					pending = undefined;
					if (result.done) {
						controller.close();
						return;
					}
					parts.push(result.value);
					size = result.value.byteLength;
				}
				// Why no read when `done`: the host reads a body the same way as `readQueued`, and it sends
				// a body with its `Content-Length` only when the body ends within that read.
				while (chunks.length === 0 && pending == null && !done && size < MAX_JOINED_BYTES) {
					// oxlint-disable-next-line no-await-in-loop -- each read takes only a chunk that is queued already.
					const next = await readIfQueued(reader);
					if ("pending" in next) {
						({ pending } = next);
					} else if (next.result.done) {
						done = true;
					} else if (next.result.value.byteLength === 0) {
						// Why stop: empty chunks add no bytes, so a source of them would hold the join open.
						break;
					} else if (fits(next.result.value)) {
						parts.push(next.result.value);
						size += next.result.value.byteLength;
					} else {
						chunks.push(next.result.value);
					}
				}
				controller.enqueue(join(parts, size));
				if (done && chunks.length === 0) {
					controller.close();
				}
			},
			cancel: async (reason) => reader.cancel(reason),
		},
		// Why 0: the stream reads its source only when the consumer reads.
		{ highWaterMark: 0 },
	);
}

/**
 * Gzips text responses and flushes after each chunk, so a streamed page shell
 * or a server-sent event reaches the client at once. Chunks that the body has
 * queued together are one chunk, up to 16 KiB. `hono/compress` holds a
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
			if (gzip == null) {
				return next();
			}
			// Why state for the hook: the code after `next()` decides, and the hook changes the headers
			// where the response leaves, with no copy of the response.
			let varies = false;
			let gzipped = false;
			await withHeaderHook(context, next, (headers) => {
				const vary = varies ? withVary(headers.get("Vary"), "Accept-Encoding") : undefined;
				if (vary != null) {
					headers.set("Vary", vary);
				}
				if (gzipped) {
					headers.set("Content-Encoding", "gzip");
					headers.delete("Content-Length");
					// Why: a range of the gzip bytes cannot be served, because each response compresses again.
					headers.delete("Accept-Ranges");
				}
			});
			const response = context.res;
			const type = response.headers.get("Content-Type");
			// Why: the bytes of a type that the plugin never gzips, such as an image, do not vary by
			// `Accept-Encoding`. A response with no type, such as a 304, keeps the `Vary` of its 200.
			if (type != null && !isCompressible(type)) {
				return;
			}
			varies = true;
			const length = response.headers.get("Content-Length");
			const { body } = response;
			if (
				type == null ||
				body == null ||
				context.req.method === "HEAD" ||
				(length != null && Number(length) < MIN_COMPRESS_BYTES) ||
				preferredEncoding(context.req.header("Accept-Encoding"), ["gzip"]) == null ||
				response.headers.has("Content-Encoding") ||
				// Why: gzip changes the bytes, so a `Content-Range` would no longer match them.
				response.headers.has("Content-Range") ||
				forbidsTransform(response.headers.get("Cache-Control"))
			) {
				return;
			}
			let source: ReadableStream<Uint8Array> = body;
			let compress = true;
			if (length == null) {
				const reader = body.getReader();
				const queued = await readQueued(reader);
				const size = queued.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
				// Why: gzip makes a small body larger, and a body from a string has no `Content-Length`.
				compress = !queued.done || size >= MIN_COMPRESS_BYTES;
				source = replay(reader, queued);
			}
			// Why the hooks: a header hook of a later stage can set `no-transform`, and it runs only where
			// the response leaves.
			if (
				compress &&
				forbidsTransform(hookedHeaders(context, response.headers).get("Cache-Control"))
			) {
				compress = false;
			}
			if (source !== body || compress) {
				replaceResponse(context, new Response(compress ? gzip(source) : source, response));
			}
			gzipped = compress;
		},
	};
}
