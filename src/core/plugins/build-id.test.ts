import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testServer } from "../../test-server.js";
import { buildId } from "./build-id.js";
import { prerendered } from "./static.js";

const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-build-id-"));
writeFileSync(join(clientDirectory, "index.html"), "<h1>Home</h1>");

afterAll(() => {
	rmSync(clientDirectory, { recursive: true, force: true });
});

describe("buildId", () => {
	it("stamps documents and data requests, not other files", async () => {
		const { request } = await testServer({
			plugins: [buildId({ value: "v42" })],
			framework: { isDataRequest: (path) => path.endsWith(".data") },
			render: async (incoming) =>
				new URL(incoming.url).pathname === "/api.json"
					? Response.json({})
					: new Response("x", { headers: { "Content-Type": "text/html" } }),
		});

		expect((await request("/page")).headers.get("X-Build-Id")).toBe("v42");
		expect((await request("/page.data")).headers.get("X-Build-Id")).toBe("v42");
		expect((await request("/api.json")).headers.get("X-Build-Id")).toBeNull();
	});

	it("puts the build in the Server-Timing of documents and data responses", async () => {
		const { request } = await testServer({
			plugins: [buildId({ value: 'v"42' })],
			framework: { isDataRequest: (path) => path.endsWith(".data") },
			render: async (incoming) =>
				new URL(incoming.url).pathname === "/api.json"
					? Response.json({})
					: new Response("x", { headers: { "Content-Type": "text/html" } }),
		});
		const timing = String.raw`build;desc="v\"42"`;

		expect((await request("/page")).headers.get("Server-Timing")).toBe(timing);
		expect((await request("/page.data")).headers.get("Server-Timing")).toBe(timing);
		expect((await request("/api.json")).headers.get("Server-Timing")).toBeNull();
	});

	it("stamps the responses of the paths option, but not a response that a shared cache can keep", async () => {
		const { request } = await testServer({
			plugins: [buildId({ value: "v42", paths: (path) => path.startsWith("/api/") })],
			render: async (incoming) =>
				new URL(incoming.url).pathname === "/api/cached"
					? Response.json({}, { headers: { "Cache-Control": "public, max-age=60" } })
					: Response.json({}),
		});

		const proxied = await request("/api/keys");
		const cached = await request("/api/cached");
		const other = await request("/status.json");

		expect(
			[proxied, cached, other].map((response) => response.headers.get("X-Build-Id")),
		).toStrictEqual(["v42", null, null]);
		expect(proxied.headers.get("Server-Timing")).toBe('build;desc="v42"');
	});

	it("answers 200 with the new ID when a prerendered page did not change but the build ID did", async () => {
		const serve = async (value: string) =>
			testServer({ plugins: [buildId({ value }), prerendered()], clientDirectory });
		const etag = (await (await serve("v1")).request("/")).headers.get("ETag") ?? "";

		const response = await (await serve("v2")).request("/", { headers: { "If-None-Match": etag } });

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Build-Id")).toBe("v2");
	});
});
