import { describe, expect, it } from "vitest";
import { keptFiles } from "./static-files.js";
import type { StaticFiles } from "./types.js";

describe("keptFiles", () => {
	it("reads a file once for concurrent first requests, so the memory limit holds other files too", async () => {
		const sizes: Record<string, number> = { "/large.js": 256 * 1024, "/small.js": 1 };
		const reads: string[] = [];
		const source: StaticFiles = {
			stat: async (path) => {
				const size = sizes[path];
				return size == null ? undefined : { kind: "file", size, mtimeMs: 0 };
			},
			open: async (path) => {
				reads.push(path);
				return new Response(new Uint8Array(sizes[path] ?? 0)).body ?? new ReadableStream();
			},
		};
		const files = keptFiles(source);
		const read = async (path: string) => new Response(await files.open(path)).arrayBuffer();

		await Promise.all(Array.from({ length: 128 }, async () => read("/large.js")));
		await read("/small.js");
		await read("/small.js");

		expect(reads).toStrictEqual(["/large.js", "/small.js"]);
	});
});
