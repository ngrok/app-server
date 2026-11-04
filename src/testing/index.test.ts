import { createHash } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { cspNonce } from "../client/csp-nonce.js";
import { createServer, defaultPlugins } from "../core/create-server.js";
import { requestContext } from "../core/request-context.js";
import { createTestServer, withRequestContext } from "./index.js";
import type { TestServerOptions } from "./index.js";

const policy = { policy: (scriptSrc: string) => `script-src ${scriptSrc}` };

async function testServer(options: Omit<TestServerOptions, "app">) {
	const server = await createTestServer({
		app: createServer({
			plugins: defaultPlugins({ contentSecurityPolicy: policy }),
			logger: { log: () => {} },
		}),
		...options,
	});
	onTestFinished(server.close);
	return server;
}

describe("createTestServer", () => {
	it("serves a prerendered page with a CSP that trusts its inline scripts", async () => {
		const server = await testServer({
			files: { "providers/index.html": "<!doctype html><script>go()</script>" },
		});
		const hash = createHash("sha256").update("go()").digest("base64");

		const response = await server.request("/providers");

		await expect(response.text()).resolves.toBe("<!doctype html><script>go()</script>");
		expect(response.headers.get("Content-Security-Policy")).toBe(
			`script-src 'self' 'sha256-${hash}'`,
		);
	});

	it("gives the framework the request context of each request", async () => {
		const server = await testServer({
			framework: async () =>
				new Response(`nonce=${cspNonce()}`, { headers: { "Content-Type": "text/html" } }),
		});

		const response = await server.request("/rendered");
		const body = await response.text();

		expect(body).toMatch(/^nonce=[\w+/=-]+$/u);
		expect(response.headers.get("Content-Security-Policy")).toContain(
			`'nonce-${body.slice("nonce=".length)}'`,
		);
	});

	it("answers a request that no stage answers with a 404", async () => {
		const server = await testServer({});

		const response = await server.request("/missing");

		expect(response.status).toBe(404);
	});

	it("refuses an app that runs in another test server", async () => {
		const app = createServer({ logger: { log: () => {} } });
		const server = await createTestServer({ app });
		onTestFinished(server.close);

		await expect(createTestServer({ app })).rejects.toThrow("Give each test server a new app");
	});
});

describe("withRequestContext", () => {
	it("gives requestContext() and cspNonce() the values in work, and none after it", async () => {
		const seen = await withRequestContext({ cspNonce: "test-nonce", requestId: "req-1" }, () => ({
			nonce: cspNonce(),
			requestId: requestContext()?.requestId,
		}));

		expect(seen).toStrictEqual({ nonce: "test-nonce", requestId: "req-1" });
		expect(cspNonce()).toBeUndefined();
	});

	it("gives a logger when the values have none", async () => {
		const logger = await withRequestContext({}, () => requestContext()?.logger);

		expect(() => logger?.info("rendered")).not.toThrow();
	});
});
