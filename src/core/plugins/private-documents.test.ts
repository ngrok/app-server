import { describe, expect, it } from "vitest";
import { testServer } from "../../test-server.js";
import { privateDocuments } from "./private-documents.js";

describe("privateDocuments", () => {
	it("marks a rendered document with no Cache-Control as private", async () => {
		const { request } = await testServer({ plugins: [privateDocuments()] });

		const response = await request("/dashboard");

		expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
	});

	it("keeps the Cache-Control of a document that sets one", async () => {
		const { request } = await testServer({
			plugins: [privateDocuments()],
			render: async () =>
				new Response("<h1>Public</h1>", {
					headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=60" },
				}),
		});

		const response = await request("/pricing");

		expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
	});

	it("does not change a response that is not HTML", async () => {
		const { request } = await testServer({
			plugins: [privateDocuments()],
			render: async () => Response.json({ ok: true }),
		});

		const response = await request("/api/status");

		expect(response.headers.get("Cache-Control")).toBeNull();
	});
});
