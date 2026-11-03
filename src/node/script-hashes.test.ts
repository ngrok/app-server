import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { publicScriptHashes } from "./script-hashes.js";

const root = mkdtempSync(join(tmpdir(), "app-server-hashes-"));
const directory = join(root, "public");
mkdirSync(join(directory, "a b"), { recursive: true });
writeFileSync(join(directory, "a b/page.html"), "<script>go()</script>");
writeFileSync(join(root, "secret.html"), "<script>secret()</script>");
writeFileSync(join(directory, "data.txt"), "<script>go()</script>");

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("publicScriptHashes", () => {
	it("hashes the inline scripts of an HTML file at an encoded URL path", () => {
		expect(publicScriptHashes(directory, "/a%20b/page.html")).toStrictEqual([
			"5KYv+PUboo5h+0+YAtGRPbwv5d/QxzHslP4YGnUaxRw=",
		]);
	});

	it.each([
		["a path outside the directory", directory, "/../secret.html"],
		["an encoded path outside the directory", directory, "/%2e%2e/secret.html"],
		["a missing file", directory, "/missing.html"],
		["a directory", directory, "/a%20b"],
		["a file that is not HTML", directory, "/data.txt"],
		["a path that does not decode", directory, "/%E0%A4%A.html"],
		["no public directory", "", "/a%20b/page.html"],
	])("gives no hashes for %s", (_, from, path) => {
		expect(publicScriptHashes(from, path)).toBeUndefined();
	});
});
