import type { Transform } from "node:stream";
import {
	brotliCompressSync,
	constants,
	crc32,
	createBrotliCompress,
	createDeflateRaw,
	createGzip,
} from "node:zlib";

/**
 * A stream from {@link gzipStream} or {@link brotliStream}. Why a class: the
 * node response writer reads `busy` to hold the head for zlib's first chunk,
 * and a field costs less than a `WeakMap` entry for each response.
 */
class ZlibBody extends ReadableStream<Uint8Array> {
	/** Whether the next chunk waits only on zlib, because the source gave the bytes already. */
	public busy = false;
}

/**
 * Whether the next chunk of `stream` waits only on zlib, because its source
 * gave the bytes already. It gives `undefined` for a stream that is not from
 * {@link gzipStream} or {@link brotliStream}.
 *
 * @example
 * waitsForZlib(gzipStream(source)); // => false, until the first read gives zlib a chunk
 */
export function waitsForZlib(stream: ReadableStream<Uint8Array>): boolean | undefined {
	return stream instanceof ZlibBody ? stream.busy : undefined;
}

/**
 * The gzip header (RFC 1952): the magic number, deflate, no flags, no time,
 * and the Unix system code.
 */
const HEADER = Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 0, 3]);

/** The gzip member of an empty body: the header, a final empty block, a CRC-32 of 0, and a size of 0. */
const EMPTY_MEMBER = Buffer.concat([HEADER, Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);

/**
 * The largest body that a pooled gzip or brotli stream compresses. Why a
 * limit: above about 64 KiB, the CRC-32 of a gzip body on the main thread
 * costs more than a new zlib stream does.
 */
const POOLED_MAX_BYTES = 64 * 1024;

/** The most zlib streams that wait for a body in each pool. Why a limit: an idle deflate stream keeps about 276 KiB of zlib state. */
const MAX_IDLE = 16;

function ignore(): void {}

/**
 * A zlib stream that compresses one body at a time, the target of its output
 * and of its failure, and the size of the longest body that it compressed.
 */
type Pooled = {
	stream: Transform;
	output: (chunk: Buffer) => void;
	fail: (error: Error) => void;
	size: number;
};

/** The idle zlib streams of one encoding, the last one given back last. */
type Pool = {
	/** A new zlib stream that finishes its output with each write. */
	create: () => Transform;
	idle: Pooled[];
	/**
	 * Whether a reset keeps state of the earlier bodies, so a stream records
	 * the size of its longest body (see {@link take}).
	 */
	sized: boolean;
	/** Whether a reset lets the stream compress the next body. Else each body gets a new stream. */
	reuses: boolean;
};

function newPooled(pool: Pool): Pooled {
	const pooled: Pooled = { stream: pool.create(), output: ignore, fail: ignore, size: 0 };
	pooled.stream.on("data", (chunk: Buffer) => {
		pooled.output(chunk);
	});
	// Why both: zlib destroys the stream at a failure, and then it never calls the write callback.
	pooled.stream.on("error", (error) => {
		pooled.fail(error);
	});
	pooled.stream.on("close", () => {
		// Why the check: a stream that the pool destroys has no body, and an error costs its stack.
		if (pooled.fail !== ignore) {
			pooled.fail(new Error("The zlib stream closed."));
		}
	});
	return pooled;
}

/**
 * The deflate pool. Why `Z_FINISH`: when the output fills the buffer of the
 * stream exactly, the stream calls zlib again, and a sync flush then adds an
 * empty block. So the output would depend on earlier bodies.
 */
const DEFLATE_POOL: Pool = {
	create: () => createDeflateRaw({ flush: constants.Z_FINISH }),
	idle: [],
	sized: true,
	reuses: true,
};

/**
 * The brotli quality of a response. Why 4: for HTML, its output is smaller
 * than gzip level 6, for the same CPU time. The `compression` middleware of
 * Express also uses 4.
 */
const BROTLI_QUALITY = 4;

const BROTLI_PARAMS = {
	[constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
	[constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
};

/**
 * The brotli pool. Why not sized: a reset makes a new brotli encoder with the
 * same parameters, so the output of a body never depends on an earlier one.
 */
const BROTLI_POOL: Pool = {
	create: () =>
		createBrotliCompress({ flush: constants.BROTLI_OPERATION_FINISH, params: BROTLI_PARAMS }),
	idle: [],
	sized: false,
	// Why not on Deno: after a reset, its brotli encoder gives no bytes for the next body.
	reuses: !("Deno" in globalThis),
};

/**
 * An idle stream of `pool` for a body of `size` bytes, else a new one. It
 * takes a stream whose bodies were each no longer than this one: the longest
 * such, and of those the last one given back, whose memory is still in the
 * cache.
 *
 * Why for deflate: a reset keeps the window of zlib, and zlib reads the bytes
 * after the end of a body to hash and match its last bytes. After a longer
 * body, these are bytes of that body, so they could change the output of this
 * one. A stream whose bodies were no longer has only the zeros that zlib
 * writes after each body there, as a new stream does.
 */
function take(pool: Pool, size: number): Pooled {
	const { idle } = pool;
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
		return newPooled(pool);
	}
	const taken = idle[best];
	const last = idle.pop();
	if (taken == null || last == null) {
		return newPooled(pool);
	}
	// Why move the last one into the gap: the order of the others does not matter, and it costs no copy.
	if (last !== taken) {
		idle[best] = last;
	}
	return taken;
}

/**
 * Gives back a stream of `pool` after its body. Why reset: the next body must
 * not use the bytes of this one as a dictionary. When the pool is full, it
 * keeps the streams of the shortest bodies, which more bodies can take.
 */
function release(pool: Pool, pooled: Pooled): void {
	pooled.output = ignore;
	pooled.fail = ignore;
	const { stream } = pooled;
	// Why check the queues: a stream with output or input still queued would give it to the next body.
	if (
		!pool.reuses ||
		stream.destroyed ||
		stream.readableLength !== 0 ||
		stream.writableLength !== 0
	) {
		stream.destroy();
		return;
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each pool creates a zlib stream, which has `reset`.
	(stream as Transform & { reset: () => void }).reset();
	// Why the check: a reset that fails destroys the stream.
	if (stream.destroyed) {
		return;
	}
	const { idle } = pool;
	if (idle.length < MAX_IDLE) {
		idle.push(pooled);
		return;
	}
	let longest = 0;
	for (let index = 1; index < idle.length; index += 1) {
		if ((idle[index]?.size ?? 0) > (idle[longest]?.size ?? 0)) {
			longest = index;
		}
	}
	const evicted = idle[longest];
	if (evicted != null && evicted.size > pooled.size) {
		idle[longest] = pooled;
		evicted.stream.destroy();
	} else {
		stream.destroy();
	}
}

/** Writes `chunk` to `stream`. zlib gives all the output of the chunk before this resolves. */
async function write(stream: Transform, chunk: Uint8Array): Promise<void> {
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
 * The output of a stream of `pool` for a body of one chunk, in one zlib call.
 * `use` gets the stream while zlib compresses, so a cancel can destroy it,
 * and gets `undefined` before the stream goes back to the pool. Why only a
 * body of one chunk: a deflate reset keeps the old window, and a second write
 * reads its bytes as history. The output of one write is the same as from a
 * new stream, so it does not depend on an earlier body.
 */
async function compressOnce(
	pool: Pool,
	value: Uint8Array,
	use: (pooled: Pooled | undefined) => void,
): Promise<Buffer[]> {
	const pooled = take(pool, value.byteLength);
	use(pooled);
	const parts: Buffer[] = [];
	pooled.output = (chunk) => {
		parts.push(chunk);
	};
	try {
		await new Promise<void>((resolve, reject) => {
			pooled.fail = reject;
			pooled.stream.write(value, (error) => {
				if (error != null) {
					reject(error);
				} else if (pooled.stream.destroyed) {
					reject(new Error("The zlib stream closed."));
				} else {
					resolve();
				}
			});
		});
	} catch (error) {
		pooled.output = ignore;
		pooled.fail = ignore;
		pooled.stream.destroy();
		throw error;
	}
	if (pool.sized) {
		pooled.size = Math.max(pooled.size, value.byteLength);
	}
	// Why first: a cancel after this must not destroy a stream that the pool gives to another body.
	use(undefined);
	release(pool, pooled);
	return parts;
}

/**
 * The gzip member of a body of one chunk: the raw deflate output of a pooled
 * stream, with the header and the trailer written here.
 */
async function gzipOnce(
	value: Uint8Array,
	use: (pooled: Pooled | undefined) => void,
): Promise<Buffer> {
	const parts = await compressOnce(DEFLATE_POOL, value, use);
	const trailer = Buffer.allocUnsafe(8);
	trailer.writeUInt32LE(crc32(value), 0);
	trailer.writeUInt32LE(value.byteLength, 4);
	return Buffer.concat([HEADER, ...parts, trailer]);
}

/** The brotli stream of a body of one chunk, from a pooled encoder. */
async function brotliOnce(
	value: Uint8Array,
	use: (pooled: Pooled | undefined) => void,
): Promise<Buffer> {
	return Buffer.concat(await compressOnce(BROTLI_POOL, value, use));
}

/** How {@link zlibStream} compresses a body. */
type Codec = {
	/** A new zlib stream that flushes after each write. */
	create: () => Transform;
	/** The output for a body with no bytes. */
	empty: Buffer;
	/**
	 * The output for a body of one chunk, up to 64 KiB, with no new zlib
	 * stream. `use` gets the zlib stream while it compresses.
	 */
	once: (value: Uint8Array, use: (pooled: Pooled | undefined) => void) => Promise<Buffer>;
};

/**
 * Compresses a byte stream with `codec`. Each written chunk is readable at
 * once. It reads the next source chunk only when the consumer pulls, so a
 * slow client holds back the source. When the source ends by the time zlib
 * finishes a chunk, that chunk and the end of the stream go out as one. Why:
 * the host writes each chunk to the socket on its own, and a write costs more
 * than its few bytes.
 */
function zlibStream(source: ReadableStream<Uint8Array>, codec: Codec): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let ended = false;
	const markEnded = () => {
		ended = true;
	};
	// Why a flag: after each zlib write, it tells with no read whether the source ended meanwhile.
	void reader.closed.then(markEnded, () => {});
	/** The zlib stream of a body of more than one chunk. */
	let zlib: Transform | undefined;
	/** The pooled zlib stream while it compresses the one chunk of a body. */
	let pooled: Pooled | undefined;
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
	const startZlib = (
		body: ZlibBody,
		controller: ReadableStreamDefaultController<Uint8Array>,
	): Transform => {
		const created = codec.create();
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
	const stream: ZlibBody = new ZlibBody(
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
							controller.enqueue(codec.empty);
							controller.close();
							return;
						}
						stream.busy = true;
						// Why wait: a source that closes in the pull that gave this chunk ends one microtask later.
						await Promise.resolve();
						if (ended && chunk.value.byteLength <= POOLED_MAX_BYTES) {
							const output = await codec.once(chunk.value, (each) => {
								pooled = each;
							});
							stream.busy = false;
							controller.enqueue(output);
							controller.close();
							return;
						}
					}
					zlib ??= startZlib(stream, controller);
					stream.busy = true;
					if (chunk.done) {
						zlib.end();
						return;
					}
					await write(zlib, chunk.value);
					if (ended) {
						zlib.end();
						return;
					}
					stream.busy = false;
					// Why the output is here: zlib emits the output of a chunk before it calls the write
					// callback, so this pull enqueues a chunk and the consumer's read does not wait.
					enqueueHeld(controller);
				} catch (error) {
					stream.busy = false;
					zlib?.destroy();
					throw error;
				}
			},
			// Why cancel the source: a client disconnect must reach the handler, so it stops its work.
			async cancel(reason) {
				zlib?.destroy();
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

const GZIP: Codec = {
	create: () => createGzip({ flush: constants.Z_SYNC_FLUSH }),
	empty: EMPTY_MEMBER,
	once: gzipOnce,
};

/**
 * Gzips a byte stream. `Z_SYNC_FLUSH` makes each written chunk readable at
 * once. It reads the next source chunk only when the consumer pulls, so a slow
 * client holds back the source. When the source ends by the time zlib
 * finishes a chunk, that chunk and the gzip trailer go out as one.
 *
 * A body that ends with its first chunk, up to 64 KiB, takes a pooled raw
 * deflate stream. Why: a new zlib stream costs more main-thread time than
 * zlib takes for a small page.
 *
 * @example
 * new Response(gzipStream(response.body), response);
 */
export function gzipStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	return zlibStream(source, GZIP);
}

const BROTLI: Codec = {
	create: () =>
		createBrotliCompress({ flush: constants.BROTLI_OPERATION_FLUSH, params: BROTLI_PARAMS }),
	empty: brotliCompressSync(new Uint8Array(), { params: BROTLI_PARAMS }),
	once: brotliOnce,
};

/**
 * Compresses a byte stream with brotli, quality 4. `BROTLI_OPERATION_FLUSH`
 * makes each written chunk readable at once. It reads and ends as
 * {@link gzipStream} does, and a body that ends with its first chunk, up to
 * 64 KiB, also takes a pooled encoder.
 *
 * @example
 * new Response(brotliStream(response.body), response);
 */
export function brotliStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	return zlibStream(source, BROTLI);
}
