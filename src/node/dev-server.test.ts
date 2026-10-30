import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createServer, serverInternals } from "../core/create-server.js";
import { accessLog } from "../core/plugins/access-log.js";
import { bodyLimit } from "../core/plugins/body-limit.js";
import { requestId } from "../core/plugins/request-id.js";
import { assets } from "../core/plugins/static.js";
import type { Plugin } from "../core/types.js";
import type { LoggedLine } from "../test-server.js";
import { productionSetup, stubFramework } from "../test-server.js";
import { devServerStage } from "./dev-server.js";
import type { NodeMiddleware } from "./dev-server.js";
import { tcp } from "./tcp.js";

describe("devServerStage", () => {
	it("sends the request ID with the middleware's answer and logs its status and length", async () => {
		const lines: LoggedLine[] = [];
		const app = createServer({
			plugins: [requestId(), accessLog(), assets()],
			logger: {
				log: (level, message, attributes) => {
					lines.push({ level, message, attributes });
				},
			},
			listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		});
		const viteMiddleware: NodeMiddleware = (_, response) => {
			response.statusCode = 418;
			response.setHeader("Content-Length", "6");
			response.end("teapot");
		};
		const internals = serverInternals(app);
		const logger = { log: () => {} };
		await internals?.prepare({
			...(await productionSetup({ logger })),
			mode: "development",
			devServer: devServerStage(viteMiddleware),
		});
		const server = await internals?.listen(stubFramework(), []);

		const response = await fetch(new URL("/@vite/client", server?.urls[0]), {
			headers: { "X-Request-Id": "abc-123" },
		});
		await server?.shutdown();

		expect(response.status).toBe(418);
		await expect(response.text()).resolves.toBe("teapot");
		expect(response.headers.get("X-Request-Id")).toBe("abc-123");
		expect(lines.find((line) => line.message === "request")?.attributes).toMatchObject({
			"http.status_code": 418,
			"network.bytes_written": 6,
		});
	});

	it("leaves the request body to the middleware after the body limit and an async stage", async () => {
		const later: Plugin = {
			name: "later",
			middleware: async (_, next) => {
				// Why: the body arrives while a stage waits, such as an auth check.
				await setImmediate();
				await next();
			},
		};
		const app = createServer({
			plugins: [bodyLimit({ maxBytes: 100 }), later, assets()],
			logger: { log: () => {} },
			listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		});
		const echoMiddleware: NodeMiddleware = (request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
			});
			request.on("end", () => {
				response.end(`got ${Buffer.concat(chunks).byteLength}`);
			});
		};
		const internals = serverInternals(app);
		const logger = { log: () => {} };
		await internals?.prepare({
			...(await productionSetup({ logger })),
			mode: "development",
			devServer: devServerStage(echoMiddleware),
		});
		const server = await internals?.listen(stubFramework(), []);

		try {
			const response = await fetch(new URL("/api/upload", server?.urls[0]), {
				method: "POST",
				body: "x".repeat(30),
				signal: AbortSignal.timeout(2_000),
			});

			await expect(response.text()).resolves.toBe("got 30");
		} finally {
			await server?.shutdown();
		}
	});
});
