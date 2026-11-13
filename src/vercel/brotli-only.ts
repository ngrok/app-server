import { Duplex } from "node:stream";
import { createBrotliDecompress } from "node:zlib";
import { copyPath } from "../core/compression.js";
import type { ByteRange, StaticFiles } from "../core/types.js";

/**
 * The URL path of the list that `vercel()` writes in the function's client
 * build: a {@link FunctionFiles}. Why a dotfile: the static stages never
 * serve one.
 */
export const FILE_LIST = "/.app-server-files.json";

/** The files of the client build that a function holds, as `vercel()` lists them. */
export type FunctionFiles = {
	/**
	 * The time of the build, in milliseconds. Why: the deploy gives each file
	 * of the function one fixed time, so a file that changes and keeps its size
	 * would keep its ETag.
	 */
	builtAt: number;
	/** The size of each file in the function, by the URL path of the file. */
	files: Record<string, number>;
	/** The size of each file whose only copy in the function is its brotli copy, by the URL path of the file. */
	brotliOnly: Record<string, number>;
};

/** The bytes of `range` in `stream`. It cancels `stream` after the last byte. */
function sliced(stream: ReadableStream<Uint8Array>, { start, end }: ByteRange) {
	let position = 0;
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				const from = Math.max(start - position, 0);
				const to = Math.min(end + 1 - position, chunk.byteLength);
				position += chunk.byteLength;
				if (to > from) {
					controller.enqueue(chunk.subarray(from, to));
				}
				if (position > end) {
					controller.terminate();
				}
			},
		}),
	);
}

/**
 * The bytes of the stream that `open` gives, with `open` called on the first
 * read. Why: a pipe reads its source at once, and a stage can drop a response
 * that no one reads.
 */
function decodedOnRead(
	open: () => Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
	let reader: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined;
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				reader ??= open().then((stream) => stream.getReader());
				const { done, value } = await (await reader).read();
				if (done) {
					controller.close();
				} else {
					controller.enqueue(value);
				}
			},
			async cancel(reason) {
				await (await reader)?.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}

/**
 * An `open` that reads each file of `brotliOnly` from its brotli copy, which
 * it decompresses, and each other file with `open`. Why: a function then
 * keeps one copy of the file, not three, and a client that accepts brotli, as
 * each browser does, gets the copy with no work.
 *
 * @example
 * brotliOnlyOpen(nodeFiles("build/client").open, new Set(["/blog/index.html"]))("/blog/index.html");
 */
export function brotliOnlyOpen(
	open: StaticFiles["open"],
	brotliOnly: ReadonlySet<string>,
): StaticFiles["open"] {
	return async (path, range) => {
		if (!brotliOnly.has(path)) {
			return open(path, range);
		}
		return decodedOnRead(async () => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Node.js types its web streams apart from the global ones.
			const decompress = Duplex.toWeb(createBrotliDecompress()) as ReadableWritablePair<
				Uint8Array,
				Uint8Array
			>;
			const decoded = (await open(copyPath(path, "br"))).pipeThrough(decompress);
			return range == null ? decoded : sliced(decoded, range);
		});
	};
}
