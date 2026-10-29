import { describe, expect, it } from "vitest";
import { testServer } from "../test-server.js";
import { buildId } from "./build-id.js";

describe("buildId", () => {
	it("stamps documents and data requests, not other files", async () => {
		const { request } = await testServer({
			plugins: [buildId({ value: "v42" })],
			render: async (incoming) =>
				new URL(incoming.url).pathname === "/api.json"
					? Response.json({})
					: new Response("x", { headers: { "Content-Type": "text/html" } }),
		});

		expect((await request("/page")).headers.get("X-Build-Id")).toBe("v42");
		expect((await request("/page.data")).headers.get("X-Build-Id")).toBe("v42");
		expect((await request("/api.json")).headers.get("X-Build-Id")).toBeNull();
	});
});
