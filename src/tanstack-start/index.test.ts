import { describe, expect, it, vi } from "vitest";
import { requestId } from "../core/plugins/request-id.js";
import { testServer } from "../test-server.js";
import { runtime } from "./index.js";

describe("runtime", () => {
	it("gives Start the app server's request context on a host with no request storage", async () => {
		const fetch = vi.fn<(request: Request, options?: unknown) => Response>(
			() => new Response("ok"),
		);
		const framework = runtime({ default: { fetch } }, { mode: "production" });
		const { request } = await testServer({ plugins: [requestId()], render: framework.fetch });

		await request("/", { headers: { "X-Request-Id": "abc-123" } });

		expect(fetch.mock.calls[0]?.[1]).toMatchObject({
			context: { appServer: { requestId: "abc-123", logger: expect.any(Object) } },
		});
	});

	it("accepts a Response of the original type after a listener replaces the global", async () => {
		const OriginalResponse = Response;
		vi.stubGlobal("Response", class extends OriginalResponse {});
		try {
			const framework = runtime(
				{ default: { fetch: () => new OriginalResponse("from fetch") } },
				{ mode: "production" },
			);
			const { request } = await testServer({ plugins: [], render: framework.fetch });

			const response = await request("/");

			expect(response.status).toBe(200);
			await expect(response.text()).resolves.toBe("from fetch");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("marks Start's server function requests as data requests", () => {
		const framework = runtime({ default: { fetch: () => new Response() } }, { mode: "production" });

		expect(framework.isDataRequest?.("/_serverFn/abc")).toBe(true);
		expect(framework.isDataRequest?.("/about")).toBe(false);
	});

	it("marks requests under a configured server function prefix as data requests", () => {
		const framework = runtime(
			{ default: { fetch: () => new Response() } },
			{ mode: "production", serverFnBase: "/rpc/" },
		);

		expect(framework.isDataRequest?.("/rpc/abc")).toBe(true);
		expect(framework.isDataRequest?.("/_serverFn/abc")).toBe(false);
	});

	it("refuses a module with no Start server entry", () => {
		expect(() => runtime({ default: {} }, { mode: "production" })).toThrow(
			"no TanStack Start server entry",
		);
	});
});
