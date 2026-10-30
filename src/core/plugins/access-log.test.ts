import { describe, expect, it } from "vitest";
import { heldStream, testServer } from "../../test-server.js";
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
		while ((await reader?.read())?.done === false) {
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

	it("logs a line when the response body fails", async () => {
		const { request, lines } = await testServer({
			plugins: [accessLog()],
			render: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							controller.error(new Error("render failed"));
						},
					}),
				),
		});

		const response = await request("/");
		await expect(response.text()).rejects.toThrow("render failed");

		expect(lines[0]?.attributes["http.client_aborted"]).toBe(true);
	});

	it("logs a HEAD request to an app route", async () => {
		const { request, lines } = await testServer({
			plugins: [accessLog()],
			routes: (app) => {
				app.get("/livez", (context) => context.text("ok"));
			},
		});

		await request("/livez", { method: "HEAD" });

		expect(lines[0]?.attributes["network.bytes_written"]).toBe(0);
	});

	it("adds the app's attributes to the line, and Server-Timing to a document when asked", async () => {
		const { request, lines } = await testServer({
			plugins: [accessLog({ attributes: () => ({ "usr.id": "user-1" }), serverTiming: true })],
		});

		const response = await request("/");
		await response.text();

		expect(lines[0]?.attributes).toMatchObject({ "usr.id": "user-1" });
		expect(response.headers.get("Server-Timing")).toMatch(/^app;dur=\d+\.\d$/u);
	});

	it("keeps the response and logs one error line when the attributes callback throws", async () => {
		const { request, lines } = await testServer({
			plugins: [
				accessLog({
					attributes: () => {
						throw new Error("no user");
					},
				}),
			],
		});

		const head = await request("/", { method: "HEAD" });
		const get = await request("/");
		await get.text();

		expect([head.status, get.status]).toStrictEqual([200, 200]);
		expect(
			lines.map((line) => [line.level, line.message, line.attributes["error.message"]]),
		).toStrictEqual([
			["error", "access log attributes failed", "no user"],
			["error", "access log attributes failed", "no user"],
		]);
	});

	it("redacts the query of the Referer", async () => {
		const { request, lines } = await testServer({ plugins: [accessLog()] });

		await (
			await request("/", { headers: { Referer: "https://example.com/verify?code=123" } })
		).text();

		expect(lines[0]?.attributes["http.referer"]).toBe("https://example.com/verify?code=REDACTED");
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
