import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testServer } from "../../test-server.js";
import { noindex } from "./noindex.js";
import { prerendered } from "./static.js";

const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-noindex-"));
writeFileSync(join(clientDirectory, "about.html"), "<h1>About</h1>");

afterAll(() => {
	rmSync(clientDirectory, { recursive: true, force: true });
});

describe("noindex", () => {
	it("sets X-Robots-Tag on a prerendered page and on a rendered page", async () => {
		const { request } = await testServer({ plugins: [noindex(), prerendered()], clientDirectory });

		const prerenderedPage = await request("/about.html");
		const renderedPage = await request("/dashboard");

		expect(prerenderedPage.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
		expect(renderedPage.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
	});
});
