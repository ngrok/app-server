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

/** The most deflate streams that wait for a body. Why a limit: each one keeps about 270 KiB of zlib state. */
const MAX_IDLE = 16;

function ignore(): void {}

/** A raw deflate stream that compresses one body at a time, and the target of its output. */
type Deflater = { stream: DeflateRaw; output: (chunk: Buffer) => void };

function newDeflater(): Deflater {
	const deflater: Deflater = {
		stream: createDeflateRaw({ flush: constants.Z_SYNC_FLUSH }),
		output: ignore,
	};
	deflater.stream.on("data", (chunk: Buffer) => {
		deflater.output(chunk);
	});
	// Why: the write callback gets the error. With no listener, the error stops the process.
	deflater.stream.on("error", ignore);
	return deflater;
}

/** The deflate streams that wait for a body, the last one given back first. */
const idle: Deflater[] = [];

/**
 * Gives back a deflate stream after its body. Why reset: the next body must
 * not use the bytes of this one as a dictionary.
 */
function release(deflater: Deflater): void {
	deflater.output = ignore;
	const { stream } = deflater;
	// Why check the queues: a stream with output or input still queued would give it to the next body.
	if (
		stream.destroyed ||
		idle.length >= MAX_IDLE ||
		stream.readableLength !== 0 ||
		stream.writableLength !== 0
	) {
		stream.destroy();
		return;
	}
	stream.reset();
	// Why the check: a reset that fails destroys the stream.
	if (!stream.destroyed) {
		idle.push(deflater);
	}
}

/** Writes `chunk` to `stream` with a sync flush. zlib gives all the output before this resolves. */
async function write(stream: DeflateRaw | Gzip, chunk: Uint8Array): Promise<void> {
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
 * second write reads one byte of it, so its output could show a byte of an
 * earlier body. The output of one write is the same as from a new stream.
 */
async function gzipOnce(value: Uint8Array, use: (deflater: Deflater) => void): Promise<Buffer> {
	const deflater = idle.pop() ?? newDeflater();
	use(deflater);
	const parts: Buffer[] = [HEADER];
	deflater.output = (chunk) => {
		parts.push(chunk);
	};
	try {
		await write(deflater.stream, value);
	} catch (error) {
		deflater.stream.destroy();
		throw error;
	}
	release(deflater);
	const trailer = Buffer.allocUnsafe(10);
	// Why 3, 0 is a final empty block: the write ends with a sync flush, so the block starts on a byte.
	trailer[0] = 3;
	trailer[1] = 0;
	trailer.writeUInt32LE(crc32(value), 2);
	trailer.writeUInt32LE(value.byteLength, 6);
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
