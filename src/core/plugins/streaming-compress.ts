import {
	forbidsTransform,
	isCompressible,
	MIN_COMPRESS_BYTES,
	preferredEncoding,
} from "../compression.js";
import { replaceResponse, writableHeaders } from "../header-hook.js";
import type { Plugin, SetupInfo } from "../types.js";
import { withVary } from "../vary.js";

type ReadResult = ReadableStreamReadResult<Uint8Array>;

/** The chunks that a body has queued, and the read that is still open, if any. */
type Queued = { chunks: Uint8Array[]; done: boolean; pending: Promise<ReadResult> | undefined };

/**
 * The most bytes that one pull of {@link replay} joins. Why 16 KiB: a source
 * that makes a chunk on each read looks queued, so the join reads ahead of the
 * client by up to this size. A Node.js stream reads ahead by the same default.
 */
export const MAX_JOINED_BYTES = 16 * 1024;

/** The next result if `reader` has it queued, or the read that is still open. */
async function readIfQueued(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ result: ReadResult } | { pending: Promise<ReadResult> }> {
	const pending = reader.read();
	// Why: a client that leaves before the body is read must not cause an unhandled rejection.
	pending.catch(() => {});
	const result = await Promise.race([pending, Promise.resolve().then(async () => undefined)]);
	return result == null ? { pending } : { result };
}

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
 * after it. Why join: gzip flushes after each chunk, and each flush costs
 * more than the bytes. A renderer such as React queues many small chunks at
 * once. A chunk that comes later still goes out on its own. When `queued`
 * has the end, the first pull sends the chunks and closes.
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
				const parts = chunks.splice(0);
				if (parts.length === 0) {
					const result = await (pending ?? reader.read());
					pending = undefined;
					if (result.done) {
						controller.close();
						return;
					}
					parts.push(result.value);
				}
				let size = parts.reduce((sum, part) => sum + part.byteLength, 0);
				// Why no read when `done`: the host reads a body the same way as `readQueued`, and it sends
				// a body with its `Content-Length` only when the body ends within that read.
				while (pending == null && !done && size < MAX_JOINED_BYTES) {
					// oxlint-disable-next-line no-await-in-loop -- each read takes only a chunk that is queued already.
					const next = await readIfQueued(reader);
					if ("pending" in next) {
						({ pending } = next);
					} else if (next.result.done) {
						done = true;
					} else {
						parts.push(next.result.value);
						size += next.result.value.byteLength;
					}
				}
				controller.enqueue(join(parts, size));
				if (done) {
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
			await next();
			if (gzip == null) {
				return;
			}
			const response = context.res;
			const type = response.headers.get("Content-Type");
			// Why: the bytes of a type that the plugin never gzips, such as an image, do not vary by
			// `Accept-Encoding`. A response with no type, such as a 304, keeps the `Vary` of its 200.
			if (type != null && !isCompressible(type)) {
				return;
			}
			const vary = withVary(response.headers.get("Vary"), "Accept-Encoding");
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
				if (vary != null) {
					writableHeaders(context).set("Vary", vary);
				}
				return;
			}
			let source: ReadableStream<Uint8Array> = body;
			let gzipped = true;
			if (length == null) {
				const reader = body.getReader();
				const queued = await readQueued(reader);
				const size = queued.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
				// Why: gzip makes a small body larger, and a body from a string has no `Content-Length`.
				gzipped = !queued.done || size >= MIN_COMPRESS_BYTES;
				source = replay(reader, queued);
			}
			// Why one copy: the new body needs a new response, and its headers change in place.
			const replacement = new Response(gzipped ? gzip(source) : source, response);
			replaceResponse(context, replacement);
			if (vary != null) {
				replacement.headers.set("Vary", vary);
			}
			if (gzipped) {
				replacement.headers.set("Content-Encoding", "gzip");
				replacement.headers.delete("Content-Length");
				// Why: a range of the gzip bytes cannot be served, because each response compresses again.
				replacement.headers.delete("Accept-Ranges");
			}
		},
	};
}
