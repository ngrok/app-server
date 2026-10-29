import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { StaticFiles } from "../core/types.js";

/**
 * A file's bytes, one chunk for each pull, so a slow client holds one chunk,
 * not the whole file. The handle closes at the end, on an error, or on cancel.
 */
function fileStream(handle: FileHandle): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { bytesRead, buffer } = await handle.read({ buffer: new Uint8Array(65_536) });
				if (bytesRead === 0) {
					await handle.close();
					controller.close();
				} else {
					controller.enqueue(buffer.subarray(0, bytesRead));
				}
			} catch (error) {
				await handle.close();
				throw error;
			}
		},
		cancel: async () => handle.close(),
	});
}

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
			const stats = await stat(filePath(path)).catch(() => undefined);
			if (stats?.isFile() === true) {
				return { kind: "file", size: stats.size, mtimeMs: stats.mtimeMs };
			}
			return stats?.isDirectory() === true
				? { kind: "directory", size: 0, mtimeMs: stats.mtimeMs }
				: undefined;
		},
		open: async (path) => fileStream(await open(filePath(path))),
	};
}
