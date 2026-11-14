import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testServer } from "../../test-server.js";
import { defaultPlugins } from "../create-server.js";
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

	it.each(["x ngrok edge", "", "x-ngrok-edge:"])(
		"stops startup for the unlessHeader %j, which is not an HTTP header name",
		(unlessHeader) => {
			expect(() => noindex({ unlessHeader })).toThrow(
				`The unlessHeader of noindex must be an HTTP header name, not ${JSON.stringify(unlessHeader)}.`,
			);
		},
	);

	it("skips a request with the unlessHeader, and varies each response on it", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins({ noindex: { unlessHeader: "x-ngrok-edge" } }),
			clientDirectory,
		});

		const direct = await request("/about.html");
		const edge = await request("/about.html", { headers: { "x-ngrok-edge": "1" } });

		expect([direct.headers.get("X-Robots-Tag"), edge.headers.get("X-Robots-Tag")]).toStrictEqual([
			"noindex, nofollow",
			null,
		]);
		expect(edge.headers.get("Vary")?.split(", ")).toContain("x-ngrok-edge");
	});

	it("is off by default and on with true in defaultPlugins", async () => {
		const off = await testServer({ plugins: defaultPlugins(), clientDirectory });
		const on = await testServer({ plugins: defaultPlugins({ noindex: true }), clientDirectory });

		expect((await off.request("/about.html")).headers.get("X-Robots-Tag")).toBeNull();
		expect((await on.request("/about.html")).headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
	});
});
