import { constants } from "node:fs";
import { access, open, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ByteRange, FileInfo, StaticFiles } from "../core/types.js";

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

/** The bytes of `range` in the file at `path`, usually from one read. */
async function readRange(path: string, range: ByteRange): Promise<Uint8Array> {
	const buffer = new Uint8Array(range.end - range.start + 1);
	const handle = await open(path);
	try {
		let filled = 0;
		// Why a loop: a read can give fewer bytes than it asks for before the end of the file.
		while (filled < buffer.byteLength) {
			const { bytesRead } = await handle.read({
				buffer,
				offset: filled,
				position: range.start + filled,
			});
			if (bytesRead === 0) {
				break;
			}
			filled += bytesRead;
		}
		return buffer.subarray(0, filled);
	} finally {
		await handle.close();
	}
}

/** A stream of one chunk. */
function oneChunk(chunk: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (chunk.byteLength > 0) {
				controller.enqueue(chunk);
			}
			controller.close();
		},
	});
}

/** Why: these codes mean that nothing is at the path. Any other error, such as `EACCES`, throws. */
const MISSING_CODES = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG"]);

/** The value of `promise`, or `undefined` when it fails because nothing is at its path. */
async function orMissing<T>(promise: Promise<T>): Promise<T | undefined> {
	try {
		return await promise;
	} catch (error) {
		if (error instanceof Error && "code" in error && MISSING_CODES.has(String(error.code))) {
			return;
		}
		throw error;
	}
}

/** The {@link FileInfo} of a file or a directory, else `undefined`. */
function fileInfo(stats: Stats | undefined): FileInfo | undefined {
	if (stats?.isFile() === true) {
		return { kind: "file", size: stats.size, mtimeMs: stats.mtimeMs };
	}
	return stats?.isDirectory() === true
		? { kind: "directory", size: 0, mtimeMs: stats.mtimeMs }
		: undefined;
}

/**
 * The client build on the file system. A relative `clientDirectory` is
 * relative to the working directory.
 *
 * Its `snapshot` reads each file and directory once. It throws for an error
 * that does not mean a missing file, so the server does not start.
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
	const files: StaticFiles = {
		stat: async (path) => fileInfo(await orMissing(stat(filePath(path)))),
		open: async (path, range) => {
			const candidate = filePath(path);
			if (range != null && range.end - range.start < CHUNK_BYTES) {
				return oneChunk(await readRange(candidate, range));
			}
			// Why: an unreadable file then gets a logged 500, not a 200 whose body fails. The check
			// holds no `FileHandle`, so a response that no one reads leaves nothing open.
			await access(candidate, constants.R_OK);
			return fileStream(candidate, range);
		},
		snapshot: async () => {
			const entries = new Map<string, FileInfo>();
			// Why the inodes of the parents: a symbolic link to a parent directory must not make the
			// walk endless. A link to another directory, such as a sibling, still lists its files.
			const walk = async (
				path: string,
				stats: Stats,
				parents: ReadonlySet<string>,
			): Promise<void> => {
				const info = fileInfo(stats);
				if (info == null) {
					return;
				}
				entries.set(path, info);
				const inode = `${stats.dev}:${stats.ino}`;
				if (info.kind === "file" || parents.has(inode)) {
					return;
				}
				const inside = new Set(parents).add(inode);
				const prefix = path === "/" ? "" : path;
				// Why: a deploy can remove a directory between its `stat` and this read.
				const names = (await orMissing(readdir(filePath(path)))) ?? [];
				await Promise.all(
					names.map(async (name) => {
						const childPath = `${prefix}/${name}`;
						const childStats = await orMissing(stat(filePath(childPath)));
						if (childStats != null) {
							await walk(childPath, childStats, inside);
						}
					}),
				);
			};
			const rootStats = await orMissing(stat(root));
			if (rootStats != null) {
				await walk("/", rootStats, new Set());
			}
			return {
				stat: async (path) => {
					const trimmed = path.length > 1 ? path.replace(/\/$/u, "") : path;
					const info = entries.get(trimmed);
					// Why only a directory after a `/`: as on the disk, `/docs/` finds `/docs`, and
					// `/llms.txt/` finds nothing.
					return trimmed === path || info?.kind === "directory" ? info : undefined;
				},
				open: files.open,
			};
		},
	};
	return files;
}
