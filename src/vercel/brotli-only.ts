import { Duplex } from "node:stream";
import { createBrotliDecompress } from "node:zlib";
import { copyPath } from "../core/compression.js";
import type { ByteRange, StaticFiles } from "../core/types.js";

/**
 * The URL path of the list that `vercel()` writes in the function's client
 * build: the size of each file whose only copy in the function is its brotli
 * copy, by the URL path of the file. Why a dotfile: the static stages never
 * serve one.
 */
export const BROTLI_ONLY_LIST = "/.app-server-brotli.json";

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
 * `files` that also find each file in {@link BROTLI_ONLY_LIST}, with the
 * size from the list and the time of its brotli copy. Each read of such a
 * file decompresses its brotli copy. Why: a function then keeps one copy of
 * the file, not three, and a client that accepts brotli, as each browser
 * does, gets the copy with no work.
 *
 * @example
 * brotliOnlyFiles(nodeFiles("build/client")).open("/blog/index.html");
 */
export function brotliOnlyFiles(files: StaticFiles): StaticFiles {
	let sizes: Promise<ReadonlyMap<string, number>> | undefined;
	// Why once and late: the list does not change while the function runs, and a file found on
	// disk does not need it.
	const readSizes = async () => {
		sizes ??= files.stat(BROTLI_ONLY_LIST).then(async (info) => {
			if (info?.kind !== "file") {
				return new Map<string, number>();
			}
			const text = await new Response(await files.open(BROTLI_ONLY_LIST)).text();
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `vercel()` of this package wrote the file.
			return new Map(Object.entries(JSON.parse(text) as Record<string, number>));
		});
		return sizes;
	};
	const wrap = (inner: StaticFiles): StaticFiles => {
		const { snapshot } = inner;
		return {
			stat: async (path) => {
				const info = await inner.stat(path);
				const size = info == null ? (await readSizes()).get(path) : undefined;
				if (size == null) {
					return info;
				}
				const copy = await inner.stat(copyPath(path, "br"));
				return copy?.kind === "file" ? { kind: "file", size, mtimeMs: copy.mtimeMs } : undefined;
			},
			open: async (path, range) => {
				if (!(await readSizes()).has(path)) {
					return inner.open(path, range);
				}
				return decodedOnRead(async () => {
					// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Node.js types its web streams apart from the global ones.
					const decompress = Duplex.toWeb(createBrotliDecompress()) as ReadableWritablePair<
						Uint8Array,
						Uint8Array
					>;
					const decoded = (await inner.open(copyPath(path, "br"))).pipeThrough(decompress);
					return range == null ? decoded : sliced(decoded, range);
				});
			},
			...(snapshot == null ? {} : { snapshot: async () => wrap(await snapshot()) }),
		};
	};
	return wrap(files);
}
