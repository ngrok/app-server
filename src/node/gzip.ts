import { constants, createGzip } from "node:zlib";

/**
 * Gzips a byte stream. `Z_SYNC_FLUSH` makes each written chunk readable at
 * once. It reads the next source chunk only when the consumer pulls, so a slow
 * client holds back the source. When the source ends by the time zlib
 * finishes a chunk, that chunk and the gzip trailer go out as one. Why: the
 * host writes each chunk to the socket on its own, and a write costs more
 * than its few bytes.
 *
 * @example
 * new Response(gzipStream(response.body), response);
 */
export function gzipStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH });
	const reader = source.getReader();
	let ended = false;
	const markEnded = () => {
		ended = true;
	};
	// Why a flag: after each zlib write, it tells with no read whether the source ended meanwhile.
	void reader.closed.then(markEnded, () => {});
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
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				gzip.on("data", (chunk: Buffer) => {
					held.push(chunk);
					heldBytes += chunk.byteLength;
					// Why: the output of a large source chunk goes out while zlib still compresses the rest.
					if (heldBytes >= constants.Z_DEFAULT_CHUNK) {
						enqueueHeld(controller);
					}
				});
				gzip.on("end", () => {
					enqueueHeld(controller);
					controller.close();
				});
				gzip.on("error", (error) => {
					controller.error(error);
				});
			},
			async pull(controller) {
				try {
					let chunk = await reader.read();
					// Why skip empty chunks: gzip writes nothing for one, and a pull that enqueues nothing
					// is not called again.
					while (!chunk.done && chunk.value.byteLength === 0) {
						chunk = await reader.read();
					}
					if (chunk.done) {
						gzip.end();
						return;
					}
					const { value } = chunk;
					await new Promise<void>((resolve, reject) => {
						gzip.write(value, (error) => {
							if (error == null) {
								resolve();
							} else {
								reject(error);
							}
						});
					});
					if (ended) {
						gzip.end();
						return;
					}
					// Why the output is here: zlib emits the output of a chunk before it calls the write
					// callback, so this pull enqueues a chunk and the consumer's read does not wait.
					enqueueHeld(controller);
				} catch (error) {
					gzip.destroy();
					throw error;
				}
			},
			// Why cancel the source: a client disconnect must reach the handler, so it stops its work.
			async cancel(reason) {
				gzip.destroy();
				return reader.cancel(reason);
			},
		},
		// Why 0: the stream reads its source only when the consumer reads.
		{ highWaterMark: 0 },
	);
}
