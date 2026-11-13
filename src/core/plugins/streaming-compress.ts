import {
	forbidsTransform,
	isCompressible,
	MIN_COMPRESS_BYTES,
	preferredEncoding,
	readIfQueued,
} from "../compression.js";
import type { Encoding, ReadResult } from "../compression.js";
import { hookedHeaders, replaceResponse, withBuiltInHeaderHook } from "../header-hook.js";
import type { CompressStream, Plugin, ResponseHeaders } from "../types.js";
import { withVary } from "../vary.js";

/** The chunks that a body has queued, and the read that is still open, if any. */
type Queued = { chunks: Uint8Array[]; done: boolean; pending: Promise<ReadResult> | undefined };

/**
 * The most bytes that one pull of {@link replay} joins. Why 64 KiB: each
 * zlib write costs a trip to the thread pool, and the node host compresses a
 * body of one chunk up to 64 KiB with a pooled stream in one trip. A source
 * that makes a chunk on each read looks queued, so the join can read ahead of
 * the client by this size.
 */
export const MAX_JOINED_BYTES = 64 * 1024;

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
 * after it, up to {@link MAX_JOINED_BYTES}. Why join: zlib flushes after each
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
 * `response` with the compressed `body` and its headers. Why not in a header
 * hook: the body and its headers go together, also to the code that an outer
 * stage runs after its `next()`.
 */
function compressed(
	response: Response,
	body: ReadableStream<Uint8Array>,
	{ encoding, hasLength }: { encoding: Encoding; hasLength: boolean },
): Response {
	const replacement = new Response(body, response);
	replacement.headers.set("Content-Encoding", encoding);
	// Why the flag: a delete costs as much as a set, and a streamed page has no length.
	if (hasLength) {
		replacement.headers.delete("Content-Length");
	}
	// Why: a range of the compressed bytes cannot be served, because each response compresses again.
	replacement.headers.delete("Accept-Ranges");
	return replacement;
}

/**
 * Whether `headers` keep the body as it is: the body has an encoding, it is
 * a part of a file, or it is marked `no-transform`.
 */
function keepsBody(headers: Pick<ResponseHeaders, "get" | "has">): boolean {
	return (
		headers.has("Content-Encoding") ||
		// Why: compression changes the bytes, so a `Content-Range` would no longer match them.
		headers.has("Content-Range") ||
		forbidsTransform(headers.get("Cache-Control"))
	);
}

/**
 * Compresses text responses with brotli or gzip, and flushes after each
 * chunk, so a streamed page shell or a server-sent event reaches the client
 * at once. A client gets brotli when its `Accept-Encoding` ranks `br` at
 * least as high as `gzip`. Chunks that the body has queued together are one
 * chunk, up to 64 KiB. `hono/compress` holds a stream until it ends. Skips a
 * response that is already encoded, a partial response, one marked
 * `no-transform`, and one whose `Content-Length` is under 1 KiB. It adds
 * `Accept-Encoding` to the `Vary` of each response that it can compress. The
 * host gives the streams. On a host with none, the plugin does nothing.
 *
 * @example
 * createServer({ plugins: [requestId(), accessLog(), streamingCompress(), assets()] });
 */
export function streamingCompress(): Plugin {
	/** The host's streams, in the order that the plugin prefers them. */
	let streams = new Map<Encoding, CompressStream>();
	let offered: readonly Encoding[] = [];
	/** The encoding that an `Accept-Encoding` header prefers, with its stream. */
	const choose = (header: string | undefined) => {
		const encoding = preferredEncoding(header, offered);
		const stream = encoding == null ? undefined : streams.get(encoding);
		return encoding == null || stream == null ? undefined : { encoding, stream };
	};
	return {
		name: "streaming-compress",
		setup: ({ brotli, gzip }) => {
			streams = new Map();
			// Why brotli first: at quality 4 its output is smaller than gzip's, for the same CPU time.
			if (brotli != null) {
				streams.set("br", brotli);
			}
			if (gzip != null) {
				streams.set("gzip", gzip);
			}
			offered = [...streams.keys()];
		},
		middleware: async (context, next) => {
			if (offered.length === 0) {
				return next();
			}
			// Why a hook for `Vary`: the code after `next()` decides, and a response that the plugin does
			// not compress then needs no copy for it.
			let compressing = false;
			await withBuiltInHeaderHook(context, next, (headers) => {
				// Why: the bytes of a type that the plugin never compresses, such as an image, do not vary by
				// `Accept-Encoding`. A response with no type, such as a 304, keeps the `Vary` of its 200.
				const type = headers.get("Content-Type");
				const vary =
					type == null || isCompressible(type)
						? withVary(headers.get("Vary"), "Accept-Encoding")
						: undefined;
				if (vary != null) {
					headers.set("Vary", vary);
				}
				// Why: the hook of an inner stage can set the length of the body before compression.
				if (compressing) {
					headers.delete("Content-Length");
				}
			});
			const response = context.res;
			const type = response.headers.get("Content-Type");
			if (type != null && !isCompressible(type)) {
				return;
			}
			const length = response.headers.get("Content-Length");
			const { body } = response;
			const accept = context.req.header("Accept-Encoding");
			if (
				accept == null ||
				type == null ||
				body == null ||
				context.req.method === "HEAD" ||
				(length != null && Number(length) < MIN_COMPRESS_BYTES) ||
				keepsBody(response.headers)
			) {
				return;
			}
			// Why after the checks: most responses stop there, such as a static file with a compressed copy
			// and a 304, and they need no parse. A request with no header needs no other check.
			const chosen = choose(accept);
			if (chosen == null) {
				return;
			}
			let source: ReadableStream<Uint8Array> = body;
			let compress = true;
			if (length == null) {
				const reader = body.getReader();
				const queued = await readQueued(reader);
				const size = queued.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
				// Why: compression makes a small body larger, and a body from a string has no `Content-Length`.
				compress = !queued.done || size >= MIN_COMPRESS_BYTES;
				source = replay(reader, queued);
			}
			// Why the hooks: a header hook of a later stage can set these headers, and it runs only where
			// the response leaves.
			compress &&= !keepsBody(hookedHeaders(context, response.headers));
			if (compress) {
				compressing = true;
				replaceResponse(
					context,
					compressed(response, chosen.stream(source), {
						encoding: chosen.encoding,
						hasLength: length != null,
					}),
				);
			} else if (source !== body) {
				replaceResponse(context, new Response(source, response));
			}
		},
	};
}
