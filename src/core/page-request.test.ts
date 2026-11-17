import { describe, expect, it } from "vitest";
import { isPageRequest } from "./page-request.js";

function request(method: string, accept?: string): Request {
	return new Request("https://example.com/mcp", {
		method,
		...(accept == null ? {} : { headers: { Accept: accept } }),
	});
}

describe("isPageRequest", () => {
	it("is true for a GET or a HEAD from a browser, a wildcard, or no Accept", () => {
		const accepts = [
			undefined,
			"*/*",
			"text/*",
			"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"text/event-stream;q=0",
			"text/event-stream; charset=iso-8859-1",
		];

		expect(
			accepts.flatMap((accept) =>
				["GET", "HEAD"].filter((method) => !isPageRequest(request(method, accept))),
			),
		).toStrictEqual([]);
	});

	it("is false for a GET that accepts an event stream, in any case and with any q above 0", () => {
		const accepts = [
			"text/event-stream",
			"Text/Event-Stream",
			"application/json, text/event-stream",
			"text/html, text/event-stream;q=0.1",
			"text/event-stream; charset=utf-8",
		];

		expect(accepts.filter((accept) => isPageRequest(request("GET", accept)))).toStrictEqual([]);
	});

	it("is false for each other method", () => {
		const methods = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

		expect(methods.filter((method) => isPageRequest(request(method)))).toStrictEqual([]);
	});
});
