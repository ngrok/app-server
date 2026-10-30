import { describe, expect, it } from "vitest";
import { testServer } from "../../test-server.js";
import { accessLog } from "./access-log.js";
import { parseTraceparent, requestId } from "./request-id.js";

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

	it("adds the trace IDs of a valid traceparent to each log line", async () => {
		const { request, lines } = await testServer({
			plugins: [requestId({ datadogTraceIds: true }), accessLog()],
			render: async (_request, context) => {
				context.var.logger.info("loading");
				return new Response("ok");
			},
		});

		await (
			await request("/", {
				headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
			})
		).text();

		const trace = {
			trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
			span_id: "00f067aa0ba902b7",
			"dd.trace_id": "11803532876627986230",
			"dd.span_id": "67667974448284343",
		};
		expect(lines.map((line) => line.message)).toStrictEqual(["loading", "request"]);
		expect(lines[0]?.attributes).toMatchObject(trace);
		expect(lines[1]?.attributes).toMatchObject(trace);
	});

	it("adds no trace IDs for a traceparent that is not valid", async () => {
		const { request, lines } = await testServer({ plugins: [requestId(), accessLog()] });

		await (
			await request("/", {
				headers: { traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01" },
			})
		).text();

		expect(lines[0]?.attributes).not.toHaveProperty("trace_id");
	});
});

describe("parseTraceparent", () => {
	it("reads version 00 and a later version with extra fields, and refuses bad values", () => {
		const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
		const spanId = "00f067aa0ba902b7";

		expect(parseTraceparent(`00-${traceId}-${spanId}-01`)).toStrictEqual({ traceId, spanId });
		expect(parseTraceparent(`01-${traceId}-${spanId}-01-extra`)).toStrictEqual({ traceId, spanId });
		expect(
			[
				`00-${traceId}-${spanId}-01-extra`,
				`ff-${traceId}-${spanId}-01`,
				`00-${traceId.toUpperCase()}-${spanId}-01`,
				`00-${traceId}-0000000000000000-01`,
				undefined,
			].map((header) => parseTraceparent(header)),
		).toStrictEqual([undefined, undefined, undefined, undefined, undefined]);
	});
});
