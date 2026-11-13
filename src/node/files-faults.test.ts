import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { nodeFiles } from "./files.js";

/** The `stat` and `readdir` calls in flight now, and the most at one time. */
const calls = vi.hoisted(() => ({ now: 0, most: 0 }));

/**
 * Why: a read of a regular file can give fewer bytes than it asks for, so
 * each read gives 3. A deploy can remove a directory between its `stat` and
 * its listing, so the listing of each `vanished` directory fails. Each `stat`
 * and each listing counts in `calls` while it is in flight.
 */
vi.mock(import("node:fs/promises"), async (importOriginal) => {
	const original = await importOriginal();
	const counted = async <T>(call: () => Promise<T>): Promise<T> => {
		calls.now += 1;
		calls.most = Math.max(calls.most, calls.now);
		try {
			return await call();
		} finally {
			calls.now -= 1;
		}
	};
	return {
		...original,
		stat: (async (path: string) =>
			counted(async () => original.stat(path))) as typeof original.stat,
		readdir: (async (path: string) =>
			counted(async () => {
				if (path.endsWith("vanished")) {
					throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
				}
				return original.readdir(path);
			})) as typeof original.readdir,
		open: async (...args: Parameters<typeof original.open>) => {
			const handle = await original.open(...args);
			const read = handle.read.bind(handle);
			// Why the cast: the test calls `read` with an options object only.
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

	it("keeps at most 64 file system calls of a snapshot in flight, and lists each file", async () => {
		const wide = join(root, "wide");
		const names = Array.from({ length: 300 }, (_, index) => `page-${index}.html`);
		mkdirSync(join(wide, "docs"), { recursive: true });
		for (const name of names) {
			writeFileSync(join(wide, "docs", name), "page");
		}
		calls.most = 0;

		const files = await nodeFiles(wide).snapshot?.();
		const kinds = await Promise.all(
			names.map(async (name) => (await files?.stat(`/docs/${name}`))?.kind),
		);

		expect(calls.most).toBeGreaterThan(1);
		expect(calls.most).toBeLessThanOrEqual(64);
		expect(kinds).toStrictEqual(names.map(() => "file"));
	});
});
