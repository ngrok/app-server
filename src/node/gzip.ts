import { constants, createGzip } from "node:zlib";

/**
 * Gzips a byte stream. `Z_SYNC_FLUSH` makes each written chunk readable at
 * once. It reads the next source chunk only when the consumer pulls, so a slow
 * client holds back the source.
 */
export function gzipStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH });
	const reader = source.getReader();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			gzip.on("data", (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk));
			});
			gzip.on("end", () => {
				controller.close();
			});
			gzip.on("error", (error) => {
				controller.error(error);
			});
		},
		async pull() {
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
	});
}
