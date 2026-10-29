import { describe, expect, it } from "vitest";
import { testServer } from "../test-server.js";
import { requestId } from "./request-id.js";

describe("requestId", () => {
	it("echoes a valid incoming ID, even when the framework returns its own response", async () => {
		const { request } = await testServer({ plugins: [requestId()] });

		const response = await request("/", { headers: { "X-Request-Id": "abc-123" } });

		expect(response.headers.get("X-Request-Id")).toBe("abc-123");
	});

	it("replaces an incoming ID that is not valid with a new UUID", async () => {
		const { request } = await testServer({ plugins: [requestId()] });

		const response = await request("/", { headers: { "X-Request-Id": "<script>" } });

		expect(response.headers.get("X-Request-Id")).toMatch(/^[\da-f]{8}-[\da-f]{4}-/u);
	});
});
