import { describe, expect, it } from "vitest";
import { hasDotSegment, isFilePath, keptFiles } from "./static-files.js";
import type { StaticFiles } from "./types.js";

describe("isFilePath", () => {
	it("accepts the path of a file, a directory, and a file under /.well-known", () => {
		const paths = [
			"/",
			"/llms.txt",
			"/docs/button",
			"/docs/button/",
			"/assets/app-abc123.js",
			"/a.b/c.d",
			"/docs/v1.2/notes.",
			"/blog/my-index.html",
			"/.well-known",
			"/.well-known/",
			"/.well-known/security.txt",
		];

		expect(paths.filter((path) => !isFilePath(path))).toStrictEqual([]);
	});

	it("rejects a path with no first slash, a NUL, or a backslash", () => {
		const paths = ["", "llms.txt", "docs/button", "/a\0b", String.raw`/a\b`, String.raw`\a`];

		expect(paths.filter((path) => isFilePath(path))).toStrictEqual([]);
	});

	it("rejects a second URL for a file: an empty segment or a path that ends with /index.html", () => {
		const paths = ["//", "/a//b", "/a//", "//a", "/index.html", "/docs/index.html"];

		expect(paths.filter((path) => isFilePath(path))).toStrictEqual([]);
	});

	it("rejects a dotfile, a dot directory, and each . or .. segment", () => {
		const paths = [
			"/.env",
			"/.app-server.json",
			"/assets/.app-abc123.js.br",
			"/docs/.private/key.json",
			"/.",
			"/..",
			"/../etc/passwd",
			"/docs/..",
			"/docs/../.env",
			"/docs/./button",
		];

		expect(paths.filter((path) => isFilePath(path))).toStrictEqual([]);
	});

	it("keeps only the first segment /.well-known reachable", () => {
		const paths = [
			"/.well-known.txt",
			"/.well-knownx/a",
			"/.well-known/.env",
			"/.well-known/../.env",
			"/docs/.well-known/security.txt",
		];

		expect(paths.filter((path) => isFilePath(path))).toStrictEqual([]);
	});
});

describe("hasDotSegment", () => {
	it("finds a dotfile and a dot directory, but not /.well-known or a dot inside a name", () => {
		const dotted = [
			"/.env",
			"/docs/.index.html.br",
			"/.git/config",
			"/docs/../a",
			"/a/.well-known",
		];
		const plain = ["/", "/docs/index.html", "/a.b/c.d", "/.well-known/security.txt"];

		expect(dotted.filter((path) => !hasDotSegment(path))).toStrictEqual([]);
		expect(plain.filter((path) => hasDotSegment(path))).toStrictEqual([]);
	});
});

describe("keptFiles", () => {
	it("gives each response its own bytes, so a reader that changes or moves its chunk leaves the next response whole", async () => {
		const text = "0123456789";
		const source: StaticFiles = {
			stat: async () => ({ kind: "file", size: text.length, mtimeMs: 0 }),
			open: async () => new Response(text).body ?? new ReadableStream(),
		};
		const files = keptFiles(source);
		const chunk = async (range?: { start: number; end: number }) => {
			const { value } = await (await files.open("/digits.txt", { range })).getReader().read();
			return value ?? new Uint8Array();
		};
		const decoder = new TextDecoder();

		const changed = await chunk();
		changed.fill(0);
		const moved = await chunk();
		const before = decoder.decode(moved);
		// Why a transfer: it detaches the buffer of the chunk, as a write to a byte stream does.
		structuredClone(moved.buffer, { transfer: [moved.buffer] });
		const part = await chunk({ start: 2, end: 4 });
		part.fill(0);

		expect(before).toBe(text);
		expect(decoder.decode(await chunk())).toBe(text);
		expect(decoder.decode(await chunk({ start: 2, end: 4 }))).toBe("234");
	});

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
