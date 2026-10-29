import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { nodeFiles } from "./files.js";

const root = mkdtempSync(join(tmpdir(), "app-server-files-"));
mkdirSync(join(root, "client/docs"), { recursive: true });
writeFileSync(join(root, "client/llms.txt"), "llms");
writeFileSync(join(root, "secret.txt"), "secret");

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("nodeFiles", () => {
	it("reads a client build from a file URL", async () => {
		const files = nodeFiles(pathToFileURL(join(root, "client/")).href);

		await expect(files.stat("/llms.txt")).resolves.toMatchObject({ kind: "file", size: 4 });
		await expect(files.stat("/docs")).resolves.toMatchObject({ kind: "directory" });
		await expect(files.stat("/missing")).resolves.toBeUndefined();
		await expect(new Response(await files.open("/llms.txt")).text()).resolves.toBe("llms");
	});

	it("refuses a path outside the client build", async () => {
		const files = nodeFiles(join(root, "client"));

		await expect(files.open("/../secret.txt")).rejects.toThrow("outside the client build");
	});
});
