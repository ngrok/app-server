import { describe, expect, it, vi } from "vitest";
import { requestId } from "../core/plugins/request-id.js";
import { setRequestStore } from "../core/request-context.js";
import { host } from "../node/index.js";
import { testServer } from "../test-server.js";
import { runtime } from "./index.js";

describe("runtime", () => {
	it("gives Start the app server's request context", async () => {
		setRequestStore(host.storage);
		const fetch = vi.fn<(request: Request, options?: unknown) => Response>(
			() => new Response("ok"),
		);
		const framework = runtime({ default: { fetch } }, { mode: "production" });
		const { request } = await testServer({ plugins: [requestId()], render: framework.fetch });

		await request("/", { headers: { "X-Request-Id": "abc-123" } });

		expect(fetch.mock.calls[0]?.[1]).toMatchObject({
			context: { appServer: { requestId: "abc-123" } },
		});
		setRequestStore(undefined);
	});

	it("marks Start's server function requests as data requests", () => {
		const framework = runtime({ default: { fetch: () => new Response() } }, { mode: "production" });

		expect(framework.isDataRequest?.("/_serverFn/abc")).toBe(true);
		expect(framework.isDataRequest?.("/about")).toBe(false);
	});

	it("refuses a module with no Start server entry", () => {
		expect(() => runtime({ default: {} }, { mode: "production" })).toThrow(
			"no TanStack Start server entry",
		);
	});
});
