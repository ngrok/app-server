import { constants, crc32, createDeflateRaw, createGzip } from "node:zlib";
import type { DeflateRaw, Gzip } from "node:zlib";

/**
 * A stream from {@link gzipStream}. Why a class: the node response writer
 * reads `busy` to hold the head for zlib's first chunk, and a field costs
 * less than a `WeakMap` entry for each response.
 */
class GzipBody extends ReadableStream<Uint8Array> {
	/** Whether the next chunk waits only on zlib, because the source gave the bytes already. */
	public busy = false;
}

/**
 * Whether the next chunk of `stream` waits only on zlib, because its source
 * gave the bytes already. It gives `undefined` for a stream that is not from
 * {@link gzipStream}.
 *
 * @example
 * waitsForZlib(gzipStream(source)); // => false, until the first read gives zlib a chunk
 */
export function waitsForZlib(stream: ReadableStream<Uint8Array>): boolean | undefined {
	return stream instanceof GzipBody ? stream.busy : undefined;
}

/**
 * The gzip header (RFC 1952): the magic number, deflate, no flags, no time,
 * and the Unix system code.
 */
const HEADER = Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 0, 3]);

/** The gzip member of an empty body: the header, a final empty block, a CRC-32 of 0, and a size of 0. */
const EMPTY_MEMBER = Buffer.concat([HEADER, Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);

/**
 * The largest body that a pooled deflate stream compresses. Why a limit: the
 * CRC-32 of a pooled body runs on the main thread, and above about 64 KiB it
 * costs more than a new zlib stream does.
 */
const POOLED_MAX_BYTES = 64 * 1024;

/** The most deflate streams that wait for a body. Why a limit: each one keeps about 276 KiB of zlib state. */
const MAX_IDLE = 16;

function ignore(): void {}

/**
 * A raw deflate stream that compresses one body at a time, the target of its
 * output and of its failure, and the size of the longest body that it
 * compressed.
 */
type Deflater = {
	stream: DeflateRaw;
	output: (chunk: Buffer) => void;
	fail: (error: Error) => void;
	size: number;
};

function newDeflater(): Deflater {
	const deflater: Deflater = {
		// Why `Z_FINISH`: when the output fills the buffer of the stream exactly, the stream calls zlib
		// again, and a sync flush then adds an empty block. So the output would depend on earlier bodies.
		stream: createDeflateRaw({ flush: constants.Z_FINISH }),
		output: ignore,
		fail: ignore,
		size: 0,
	};
	deflater.stream.on("data", (chunk: Buffer) => {
		deflater.output(chunk);
	});
	// Why both: zlib destroys the stream at a failure, and then it never calls the write callback.
	deflater.stream.on("error", (error) => {
		deflater.fail(error);
	});
	deflater.stream.on("close", () => {
		// Why the check: a stream that the pool destroys has no body, and an error costs its stack.
		if (deflater.fail !== ignore) {
			deflater.fail(new Error("The deflate stream closed."));
		}
	});
	return deflater;
}

/** The deflate streams that wait for a body, the last one given back last. */
const idle: Deflater[] = [];

/**
 * An idle deflate stream for a body of `size` bytes, else a new one. It takes
 * a stream whose bodies were each no longer than this one: the longest such,
 * and of those the last one given back, whose memory is still in the cache.
 *
 * Why: a reset keeps the window of zlib, and zlib reads the bytes after the
 * end of a body to hash and match its last bytes. After a longer body, these
 * are bytes of that body, so they could change the output of this one. A
 * stream whose bodies were no longer has only the zeros that zlib writes
 * after each body there, as a new stream does.
 */
function takeDeflater(size: number): Deflater {
	let best = -1;
	let bestSize = -1;
	for (let index = idle.length - 1; index >= 0; index -= 1) {
		const each = idle[index]?.size ?? Infinity;
		if (each <= size && each > bestSize) {
			best = index;
			bestSize = each;
		}
	}
	if (best === -1) {
		return newDeflater();
	}
	const taken = idle[best];
	const last = idle.pop();
	if (taken == null || last == null) {
		return newDeflater();
	}
	// Why move the last one into the gap: the order of the others does not matter, and it costs no copy.
	if (last !== taken) {
		idle[best] = last;
	}
	return taken;
}

/**
 * Gives back a deflate stream after its body. Why reset: the next body must
 * not use the bytes of this one as a dictionary. When the pool is full, it
 * keeps the streams of the shortest bodies, which more bodies can take.
 */
function release(deflater: Deflater): void {
	deflater.output = ignore;
	deflater.fail = ignore;
	const { stream } = deflater;
	// Why check the queues: a stream with output or input still queued would give it to the next body.
	if (stream.destroyed || stream.readableLength !== 0 || stream.writableLength !== 0) {
		stream.destroy();
		return;
	}
	stream.reset();
	// Why the check: a reset that fails destroys the stream.
	if (stream.destroyed) {
		return;
	}
	if (idle.length < MAX_IDLE) {
		idle.push(deflater);
		return;
	}
	let longest = 0;
	for (let index = 1; index < idle.length; index += 1) {
		if ((idle[index]?.size ?? 0) > (idle[longest]?.size ?? 0)) {
			longest = index;
		}
	}
	const evicted = idle[longest];
	if (evicted != null && evicted.size > deflater.size) {
		idle[longest] = deflater;
		evicted.stream.destroy();
	} else {
		stream.destroy();
	}
}

/** Writes `chunk` to `stream`. zlib gives all the output of the chunk before this resolves. */
async function write(stream: Gzip, chunk: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(chunk, (error) => {
			if (error == null) {
				resolve();
			} else {
				reject(error);
			}
		});
	});
}

/**
 * The gzip member of a body of one chunk, from a pooled raw deflate stream,
 * with the header and the trailer written here, so the body needs one zlib
 * call. `use` gets the stream while zlib compresses, so a cancel can destroy
 * it. Why only a body of one chunk: a reset keeps the old window, and a
 * second write reads its bytes as history. The output of one write is the
 * same as from a new stream, so it does not depend on an earlier body.
 */
async function gzipOnce(value: Uint8Array, use: (deflater: Deflater) => void): Promise<Buffer> {
	const deflater = takeDeflater(value.byteLength);
	use(deflater);
	const parts: Buffer[] = [HEADER];
	deflater.output = (chunk) => {
		parts.push(chunk);
	};
	try {
		await new Promise<void>((resolve, reject) => {
			deflater.fail = reject;
			deflater.stream.write(value, (error) => {
				if (error != null) {
					reject(error);
				} else if (deflater.stream.destroyed) {
					reject(new Error("The deflate stream closed."));
				} else {
					resolve();
				}
			});
		});
	} catch (error) {
		deflater.output = ignore;
		deflater.fail = ignore;
		deflater.stream.destroy();
		throw error;
	}
	deflater.size = Math.max(deflater.size, value.byteLength);
	release(deflater);
	const trailer = Buffer.allocUnsafe(8);
	trailer.writeUInt32LE(crc32(value), 0);
	trailer.writeUInt32LE(value.byteLength, 4);
	parts.push(trailer);
	return Buffer.concat(parts);
}

/**
 * Gzips a byte stream. `Z_SYNC_FLUSH` makes each written chunk readable at
 * once. It reads the next source chunk only when the consumer pulls, so a slow
 * client holds back the source. When the source ends by the time zlib
 * finishes a chunk, that chunk and the gzip trailer go out as one. Why: the
 * host writes each chunk to the socket on its own, and a write costs more
 * than its few bytes.
 *
 * A body that ends with its first chunk, up to 64 KiB, takes a pooled raw
 * deflate stream. Why: a new zlib stream costs more main-thread time than
 * zlib takes for a small page.
 *
 * @example
 * new Response(gzipStream(response.body), response);
 */
export function gzipStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let ended = false;
	const markEnded = () => {
		ended = true;
	};
	// Why a flag: after each zlib write, it tells with no read whether the source ended meanwhile.
	void reader.closed.then(markEnded, () => {});
	/** The gzip stream of a body of more than one chunk. */
	let gzip: Gzip | undefined;
	/** The pooled deflate stream while it compresses the one chunk of a body. */
	let pooled: Deflater | undefined;
	let started = false;
	/** The zlib output that waits for the next enqueue. */
	let held: Buffer[] = [];
	let heldBytes = 0;
	const enqueueHeld = (controller: ReadableStreamDefaultController<Uint8Array>) => {
		const [first] = held;
		if (first == null) {
			return;
		}
		// Why no copy for one chunk: zlib gives each chunk its own bytes, and it never writes them again.
		controller.enqueue(held.length === 1 ? first : Buffer.concat(held));
		held = [];
		heldBytes = 0;
	};
	const startGzip = (
		body: GzipBody,
		controller: ReadableStreamDefaultController<Uint8Array>,
	): Gzip => {
		const created = createGzip({ flush: constants.Z_SYNC_FLUSH });
		created.on("data", (chunk: Buffer) => {
			held.push(chunk);
			heldBytes += chunk.byteLength;
			// Why: the output of a large source chunk goes out while zlib still compresses the rest.
			if (heldBytes >= constants.Z_DEFAULT_CHUNK) {
				enqueueHeld(controller);
			}
		});
		created.on("end", () => {
			body.busy = false;
			enqueueHeld(controller);
			controller.close();
		});
		created.on("error", (error) => {
			body.busy = false;
			controller.error(error);
		});
		return created;
	};
	const stream: GzipBody = new GzipBody(
		{
			async pull(controller) {
				try {
					let chunk = await reader.read();
					// Why skip empty chunks: zlib writes nothing for one, and a pull that enqueues nothing
					// is not called again.
					while (!chunk.done && chunk.value.byteLength === 0) {
						chunk = await reader.read();
					}
					if (!started) {
						started = true;
						if (chunk.done) {
							controller.enqueue(EMPTY_MEMBER);
							controller.close();
							return;
						}
						stream.busy = true;
						// Why wait: a source that closes in the pull that gave this chunk ends one microtask later.
						await Promise.resolve();
						if (ended && chunk.value.byteLength <= POOLED_MAX_BYTES) {
							const member = await gzipOnce(chunk.value, (deflater) => {
								pooled = deflater;
							});
							pooled = undefined;
							stream.busy = false;
							controller.enqueue(member);
							controller.close();
							return;
						}
					}
					gzip ??= startGzip(stream, controller);
					stream.busy = true;
					if (chunk.done) {
						gzip.end();
						return;
					}
					await write(gzip, chunk.value);
					if (ended) {
						gzip.end();
						return;
					}
					stream.busy = false;
					// Why the output is here: zlib emits the output of a chunk before it calls the write
					// callback, so this pull enqueues a chunk and the consumer's read does not wait.
					enqueueHeld(controller);
				} catch (error) {
					stream.busy = false;
					gzip?.destroy();
					throw error;
				}
			},
			// Why cancel the source: a client disconnect must reach the handler, so it stops its work.
			async cancel(reason) {
				gzip?.destroy();
				// Why destroy: a stream that a write still uses must never go back to the pool.
				pooled?.stream.destroy();
				return reader.cancel(reason);
			},
		},
		// Why 0: the stream reads its source only when the consumer reads.
		{ highWaterMark: 0 },
	);
	return stream;
}
