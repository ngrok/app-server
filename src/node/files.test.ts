import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { nodeFiles } from "./files.js";

const root = mkdtempSync(join(tmpdir(), "app-server-files-"));
mkdirSync(join(root, "client/docs"), { recursive: true });
writeFileSync(join(root, "client/llms.txt"), "llms");
writeFileSync(join(root, "secret.txt"), "secret");
symlinkSync("loop", join(root, "client/loop"));
writeFileSync(join(root, "client/unreadable.txt"), "unreadable");
chmodSync(join(root, "client/unreadable.txt"), 0o000);

/** Runs full garbage collections, and waits for the cleanup that each one queues. */
async function collectGarbage(): Promise<void> {
	setFlagsFromString("--expose-gc");
	// Why the cast: `gc` exists in a new context after the flag is set.
	const gc = runInNewContext("gc") as () => void;
	// Why three: a stream and its file handle can need more than one collection.
	for (let round = 0; round < 3; round += 1) {
		gc();
		await setTimeout(50);
	}
}

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("nodeFiles", () => {
	it("reads a client build from a file URL", async () => {
		const files = nodeFiles(pathToFileURL(join(root, "client/")).href);

		await expect(files.stat("/llms.txt")).resolves.toMatchObject({ kind: "file", size: 4 });
		await expect(files.stat("/docs")).resolves.toStrictEqual({ kind: "directory" });
		await expect(files.stat("/missing")).resolves.toBeUndefined();
		await expect(new Response(await files.open("/llms.txt")).text()).resolves.toBe("llms");
	});

	it("throws a file system error that does not mean a missing file", async () => {
		const files = nodeFiles(join(root, "client"));

		await expect(files.stat("/llms.txt/child")).resolves.toBeUndefined();
		await expect(files.stat("/loop")).rejects.toMatchObject({ code: "ELOOP" });
	});

	it("answers from a snapshot that does not change when the files change", async () => {
		const client = join(root, "snapshot");
		mkdirSync(join(client, "docs"), { recursive: true });
		writeFileSync(join(client, "docs/index.html"), "<h1>Docs</h1>");
		writeFileSync(join(client, "gone.txt"), "gone");
		symlinkSync("..", join(client, "docs/up"));
		const files = await nodeFiles(client).snapshot?.();
		rmSync(join(client, "gone.txt"));
		writeFileSync(join(client, "late.txt"), "late");
		const paths = [
			"/",
			"/docs/",
			"/docs/index.html",
			"/gone.txt",
			"/late.txt",
			"/gone.txt/child",
			"/docs/index.html/",
		];
		const kinds = await Promise.all(paths.map(async (path) => (await files?.stat(path))?.kind));

		expect(kinds).toStrictEqual([
			"directory",
			"directory",
			"file",
			"file",
			undefined,
			undefined,
			undefined,
		]);
		await expect(files?.stat("/docs")).resolves.toStrictEqual({ kind: "directory" });
	});

	it("lists the files of a directory under each symbolic link to it", async () => {
		const client = join(root, "aliases");
		mkdirSync(join(client, "real"), { recursive: true });
		writeFileSync(join(client, "real/a.txt"), "a");
		symlinkSync("real", join(client, "link"));
		const files = await nodeFiles(client).snapshot?.();

		await expect(files?.stat("/real/a.txt")).resolves.toMatchObject({ kind: "file" });
		await expect(files?.stat("/link/a.txt")).resolves.toMatchObject({ kind: "file" });
	});

	it("gives the answers of stat from a snapshot of a tree with more entries than it reads at one time", async () => {
		const client = join(root, "tree");
		const paths = ["/", "/missing", "/missing/a.txt", "/a/0/0.txt/", "/a/0/0.txt/b"];
		for (const section of ["a", "b", "c"]) {
			for (let directory = 0; directory < 8; directory += 1) {
				mkdirSync(join(client, section, String(directory)), { recursive: true });
				paths.push(`/${section}`, `/${section}/${directory}`, `/${section}/${directory}/`);
				for (let file = 0; file < 10; file += 1) {
					writeFileSync(join(client, section, String(directory), `${file}.txt`), "x".repeat(file));
					paths.push(`/${section}/${directory}/${file}.txt`);
				}
			}
		}
		symlinkSync("a", join(client, "linked"));
		// Why no path under `/b/up`: a snapshot lists a link to a parent directory, but not what is under it.
		symlinkSync("..", join(client, "b/up"));
		paths.push("/linked", "/linked/3/4.txt", "/b/up");
		const files = nodeFiles(client);
		const snapshot = await files.snapshot?.();

		const fromDisk = await Promise.all(paths.map(async (path) => files.stat(path)));
		const fromSnapshot = await Promise.all(paths.map(async (path) => snapshot?.stat(path)));

		expect(fromSnapshot).toStrictEqual(fromDisk);
		expect(fromSnapshot.filter((info) => info != null).length).toBeGreaterThan(300);
	});

	it("refuses a snapshot when a file system error does not mean a missing file", async () => {
		await expect(nodeFiles(join(root, "client")).snapshot?.()).rejects.toMatchObject({
			code: "ELOOP",
		});
	});

	it("gives an empty snapshot for a client build that does not exist", async () => {
		const files = await nodeFiles(join(root, "missing")).snapshot?.();

		await expect(files?.stat("/")).resolves.toBeUndefined();
	});

	// Why skip for root: root reads a file with no permissions.
	it.skipIf(process.getuid?.() === 0)("throws at open for a file that it cannot read", async () => {
		const files = nodeFiles(join(root, "client"));

		await expect(files.open("/unreadable.txt")).rejects.toMatchObject({ code: "EACCES" });
	});

	it("refuses a path outside the client build", async () => {
		const files = nodeFiles(join(root, "client"));

		await expect(files.open("/../secret.txt")).rejects.toThrow("outside the client build");
	});

	// Why: Node.js 26 throws an uncaught error when garbage collection closes a `FileHandle`, so a
	// body that a later stage drops without a read must hold no open file.
	it("holds no open file for a stream that no one reads", async () => {
		const files = nodeFiles(join(root, "client"));
		const errors: unknown[] = [];
		const record = (error: unknown) => {
			errors.push(error);
		};
		process.on("uncaughtException", record);
		try {
			await files.open("/llms.txt");
			await collectGarbage();
		} finally {
			process.off("uncaughtException", record);
		}

		expect(errors).toStrictEqual([]);
	});
});
