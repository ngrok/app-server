import { describe, expect, it } from "vitest";
import { heldStream, testServer } from "../test-server.js";
import { accessLog, loggedUrl } from "./access-log.js";
import { requestId } from "./request-id.js";

describe("accessLog", () => {
	it("logs one line with the request ID and the query values redacted", async () => {
		const { request, lines } = await testServer({ plugins: [requestId(), accessLog()] });

		await (await request("/verify?code=123456", { headers: { "X-Request-Id": "abc-123" } })).text();

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			level: "info",
			message: "request",
			attributes: {
				"http.request_id": "abc-123",
				"http.method": "GET",
				"http.url": "/verify?code=REDACTED",
				"http.status_code": 200,
				"network.bytes_written": 8,
			},
		});
	});

	it("logs a streamed response when its body ends, with every byte counted", async () => {
		const held = heldStream("shell");
		const { request, lines } = await testServer({
			plugins: [accessLog()],
			render: async () => held.response,
		});

		const response = await request("/streamed");
		const reader = response.body?.getReader();
		await reader?.read();
		const linesBeforeEnd = lines.length;
		held.release();
		while (!(await reader?.read())?.done) {
			// Drains the body.
		}

		expect(linesBeforeEnd).toBe(0);
		expect(lines[0]?.attributes["network.bytes_written"]).toBe(9);
	});

	it("marks a line when the client disconnects before the body ends", async () => {
		const held = heldStream("shell");
		const { request, lines } = await testServer({
			plugins: [accessLog()],
			render: async () => held.response,
		});

		const response = await request("/streamed");
		await response.body?.cancel();

		expect(lines[0]?.attributes["http.client_aborted"]).toBe(true);
	});
});

describe("loggedUrl", () => {
	it("keeps the query as is when redaction is off", () => {
		expect(loggedUrl(new URL("https://example.com/a?b=1"), { redact: false })).toBe("/a?b=1");
	});

	it("keeps the path and the query keys when redaction is on", () => {
		expect(loggedUrl(new URL("https://example.com/a?b=1&c=2"), { redact: true })).toBe(
			"/a?b=REDACTED&c=REDACTED",
		);
		expect(loggedUrl(new URL("https://example.com/a"), { redact: true })).toBe("/a");
	});
});
