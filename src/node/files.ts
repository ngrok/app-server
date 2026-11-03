import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ByteRange, StaticFiles } from "../core/types.js";

/** Why: one read fills one chunk, so a slow client holds one chunk, not the whole file. */
const CHUNK_BYTES = 65_536;

/**
 * A file's bytes, one chunk for each pull. With `range`, it reads only those
 * bytes. The file opens on the first pull and closes at the end, on an error,
 * or on cancel.
 *
 * Why open on the first pull: a stage can drop a response that no one reads,
 * such as when a later stage throws. Node.js 26 throws an uncaught error when
 * garbage collection closes an open `FileHandle`.
 */
function fileStream(path: string, range: ByteRange | undefined): ReadableStream<Uint8Array> {
	let handle: FileHandle | undefined;
	let position = range?.start ?? 0;
	const end = range == null ? Number.POSITIVE_INFINITY : range.end + 1;
	const close = async () => {
		const opened = handle;
		handle = undefined;
		await opened?.close();
	};
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const length = Math.min(CHUNK_BYTES, end - position);
					if (length > 0) {
						handle ??= await open(path);
					}
					const { bytesRead, buffer } =
						length <= 0 || handle == null
							? { bytesRead: 0, buffer: new Uint8Array(0) }
							: await handle.read({ buffer: new Uint8Array(length), position });
					if (bytesRead === 0) {
						await close();
						controller.close();
					} else {
						position += bytesRead;
						controller.enqueue(buffer.subarray(0, bytesRead));
					}
				} catch (error) {
					await close();
					throw error;
				}
			},
			cancel: close,
		},
		// Why 0: the stream opens and reads nothing until the consumer reads.
		{ highWaterMark: 0 },
	);
}

/** Why: these codes mean that nothing is at the path. Any other error, such as `EACCES`, throws. */
const MISSING_CODES = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG"]);

/**
 * The client build on the file system. A relative `clientDirectory` is
 * relative to the working directory.
 *
 * @example
 * nodeFiles("build/client").stat("/llms.txt");
 */
export function nodeFiles(clientDirectory: string): StaticFiles {
	// Why `resolve` for a URL too: it drops the trailing `/` that the containment check needs gone.
	const root = resolve(
		clientDirectory.startsWith("file:") ? fileURLToPath(clientDirectory) : clientDirectory,
	);
	// Why a second check: the static stages check each path, and this check keeps a host that
	// gets a path from elsewhere inside the root too.
	const filePath = (path: string) => {
		const candidate = join(root, path);
		if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
			throw new Error(`The path ${path} is outside the client build.`);
		}
		return candidate;
	};
	return {
		stat: async (path) => {
			const stats = await stat(filePath(path)).catch((error: unknown) => {
				if (error instanceof Error && "code" in error && MISSING_CODES.has(String(error.code))) {
					return;
				}
				throw error;
			});
			if (stats?.isFile() === true) {
				return { kind: "file", size: stats.size, mtimeMs: stats.mtimeMs };
			}
			return stats?.isDirectory() === true
				? { kind: "directory", size: 0, mtimeMs: stats.mtimeMs }
				: undefined;
		},
		open: async (path, range) => {
			const candidate = filePath(path);
			// Why: an unreadable file then gets a logged 500, not a 200 whose body fails. The check
			// holds no `FileHandle`, so a response that no one reads leaves nothing open.
			await access(candidate, constants.R_OK);
			return fileStream(candidate, range);
		},
	};
}
