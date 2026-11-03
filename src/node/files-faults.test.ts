import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { nodeFiles } from "./files.js";

/**
 * Why: a read of a regular file can give fewer bytes than it asks for, so
 * each read gives 3. A deploy can remove a directory between its `stat` and
 * its listing, so the listing of each `vanished` directory fails.
 */
vi.mock(import("node:fs/promises"), async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		readdir: (async (path: string) => {
			if (path.endsWith("vanished")) {
				throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			}
			return original.readdir(path);
		}) as typeof original.readdir,
		open: async (...args: Parameters<typeof original.open>) => {
			const handle = await original.open(...args);
			const read = handle.read.bind(handle);
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test calls `read` with an options object only.
			const shortRead = (async (options: {
				buffer: Uint8Array;
				offset?: number;
				position: number;
			}) =>
				read({
					...options,
					length: Math.min(3, options.buffer.byteLength - (options.offset ?? 0)),
				})) as FileHandle["read"];
			return Object.assign(handle, { read: shortRead });
		},
	};
});

const root = mkdtempSync(join(tmpdir(), "app-server-files-faults-"));
const text = "a static file of 27 bytes.\n";
writeFileSync(join(root, "file.txt"), text);
mkdirSync(join(root, "vanished"));

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("nodeFiles", () => {
	it("reads the whole range of a small file when each read gives fewer bytes", async () => {
		const files = nodeFiles(root);

		const body = await files.open("/file.txt", { start: 0, end: text.length - 1 });

		await expect(new Response(body).text()).resolves.toBe(text);
	});

	it("starts when a directory goes away during the snapshot", async () => {
		const files = await nodeFiles(root).snapshot?.();

		await expect(files?.stat("/file.txt")).resolves.toMatchObject({ kind: "file" });
	});
});
