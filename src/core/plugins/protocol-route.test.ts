import { describe, expect, it } from "vitest";
import { testServer } from "../../test-server.js";
import { defaultPlugins } from "../create-server.js";
import { protocolRoute } from "./protocol-route.js";
import type { ProtocolRouteOptions } from "./protocol-route.js";

const SITE = "https://site.example";

/** A test server whose `/mcp` sends each protocol request to a handler that answers `endpoint`. */
async function mcpServer(options: Partial<ProtocolRouteOptions> = {}) {
	const handled: string[] = [];
	const server = await testServer({
		plugins: defaultPlugins({
			beforeStatic: [
				protocolRoute({
					path: "/mcp",
					handle: (request) => {
						handled.push(request.method);
						return new Response("endpoint", { headers: { "Content-Type": "application/json" } });
					},
					...options,
				}),
			],
		}),
	});
	return { ...server, handled };
}

describe("protocolRoute", () => {
	it("sends a page request to the framework, with Vary: Accept", async () => {
		const { request, handled } = await mcpServer();

		const response = await request("/mcp", { headers: { Accept: "text/html, */*;q=0.8" } });

		await expect(response.text()).resolves.toBe("rendered");
		expect(response.headers.get("Vary")).toContain("Accept");
		expect(handled).toStrictEqual([]);
	});

	it("sends a GET that accepts an event stream to the handler, with Vary: Accept and CORS", async () => {
		const { request } = await mcpServer({ cors: { origin: "*" } });

		const response = await request("/mcp", {
			headers: { Accept: "text/event-stream", Origin: SITE },
		});

		await expect(response.text()).resolves.toBe("endpoint");
		expect(response.headers.get("Vary")).toContain("Accept");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("sends a POST to the handler, with CORS for an allowed origin", async () => {
		const { request } = await mcpServer({ cors: { origin: [SITE] } });

		const allowed = await request("/mcp", { method: "POST", headers: { Origin: SITE } });
		const other = await request("/mcp", {
			method: "POST",
			headers: { Origin: "https://other.example" },
		});

		await expect(allowed.text()).resolves.toBe("endpoint");
		expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
		expect(allowed.headers.get("Vary")).toContain("Origin");
		expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("answers a preflight with the CORS answer, so the handler and the framework never see it", async () => {
		const { request, handled } = await mcpServer({ cors: { origin: "*" } });

		const response = await request("/mcp", {
			method: "OPTIONS",
			headers: { Origin: SITE, "Access-Control-Request-Method": "POST" },
		});

		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
		expect(handled).toStrictEqual([]);
	});

	it("sends an OPTIONS request to the handler when it has no CORS options, and adds no CORS headers", async () => {
		const { request, handled } = await mcpServer();

		const response = await request("/mcp", { method: "OPTIONS", headers: { Origin: SITE } });

		await expect(response.text()).resolves.toBe("endpoint");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(handled).toStrictEqual(["OPTIONS"]);
	});

	it("sends each other path to the framework with no Vary: Accept, such as a data request", async () => {
		const { request, handled } = await mcpServer();

		const responses = await Promise.all(
			["/mcp.data", "/mcp/tools", "/"].map(async (path) => request(path, { method: "POST" })),
		);

		await expect(
			Promise.all(responses.map(async (response) => response.text())),
		).resolves.toStrictEqual(["rendered", "rendered", "rendered"]);
		expect(responses.map((response) => response.headers.get("Vary"))).not.toContain("Accept");
		expect(handled).toStrictEqual([]);
	});

	it("answers an error of the handler with the app's onError", async () => {
		const { request } = await mcpServer({
			handle: () => {
				throw new Error("the handler failed");
			},
		});

		expect((await request("/mcp", { method: "POST" })).status).toBe(500);
	});

	it("adds Vary: Origin to the error answer of the handler, with the CORS headers of an allowed origin", async () => {
		const { request } = await mcpServer({
			cors: { origin: [SITE] },
			handle: () => {
				throw new Error("the handler failed");
			},
		});

		const response = await request("/mcp", { method: "POST", headers: { Origin: SITE } });

		expect(response.status).toBe(500);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
		expect(response.headers.get("Vary")).toContain("Origin");
	});

	it("stops startup for a path that does not start with a slash, or that has a query or a fragment", () => {
		const handle = () => new Response();

		expect(() => protocolRoute({ path: "mcp", handle })).toThrow(
			'protocolRoute needs a path that starts with "/", not "mcp".',
		);
		expect(() => protocolRoute({ path: "/mcp?x", handle })).toThrow(
			'protocolRoute needs a path with no "?" and no "#", not "/mcp?x".',
		);
	});
});
