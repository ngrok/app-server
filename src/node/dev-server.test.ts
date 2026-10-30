import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createServer, serverInternals } from "../core/create-server.js";
import { accessLog } from "../core/plugins/access-log.js";
import { withHeaderHook } from "../core/header-hook.js";
import { bodyLimit } from "../core/plugins/body-limit.js";
import { buildId } from "../core/plugins/build-id.js";
import { noindex } from "../core/plugins/noindex.js";
import { securityHeaders } from "../core/plugins/security-headers.js";
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

	it("sends the headers of the earlier stages with the middleware's answer, and keeps its own values", async () => {
		const app = createServer({
			plugins: [
				securityHeaders({ headers: { "Content-Security-Policy": "frame-ancestors 'none'" } }),
				noindex(),
				assets(),
			],
			logger: { log: () => {} },
			listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		});
		const viteMiddleware: NodeMiddleware = (request, response, next) => {
			if (request.url === "/set.html") {
				response.setHeader("Content-Type", "text/html");
				response.setHeader("Referrer-Policy", "no-referrer");
				response.end("<h1>Static</h1>");
			} else if (request.url === "/write-head.html") {
				response.writeHead(200, { "Content-Type": "text/html", "Referrer-Policy": "no-referrer" });
				response.end("<h1>Static</h1>");
			} else {
				next();
			}
		};
		const internals = serverInternals(app);
		const logger = { log: () => {} };
		await internals?.prepare({
			...(await productionSetup({ logger })),
			mode: "development",
			devServer: devServerStage(viteMiddleware),
		});
		const server = await internals?.listen(stubFramework(), []);

		const headersOf = async (path: string) => {
			const response = await fetch(new URL(path, server?.urls[0]));
			await response.text();
			return {
				nosniff: response.headers.get("X-Content-Type-Options"),
				opener: response.headers.get("Cross-Origin-Opener-Policy"),
				referrer: response.headers.get("Referrer-Policy"),
				csp: response.headers.get("Content-Security-Policy"),
				robots: response.headers.get("X-Robots-Tag"),
			};
		};
		const expected = {
			nosniff: "nosniff",
			opener: "same-origin",
			referrer: "no-referrer",
			csp: "frame-ancestors 'none'",
			robots: "noindex, nofollow",
		};

		try {
			await expect(headersOf("/set.html")).resolves.toStrictEqual(expected);
			await expect(headersOf("/write-head.html")).resolves.toStrictEqual(expected);
			await expect(headersOf("/rendered")).resolves.toStrictEqual({
				...expected,
				referrer: "strict-origin-when-cross-origin",
			});
		} finally {
			await server?.shutdown();
		}
	});

	it("runs the header hooks in the production order, also for array headers of writeHead", async () => {
		const appPolicy: Plugin = {
			name: "app-policy",
			middleware: async (context, next) =>
				withHeaderHook(context, next, (response) => {
					response.set("Content-Security-Policy", "script-src 'self'");
				}),
		};
		const app = createServer({
			plugins: [
				securityHeaders({ headers: { "Content-Security-Policy": "frame-ancestors 'none'" } }),
				buildId({ value: "v1" }),
				appPolicy,
				assets(),
			],
			logger: { log: () => {} },
			listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		});
		const viteMiddleware: NodeMiddleware = (request, response, next) => {
			if (request.url === "/array.html") {
				response.writeHead(200, ["Content-Type", "text/html"]);
				response.end("<h1>Static</h1>");
			} else if (request.url === "/set.html") {
				response.setHeader("Content-Type", "text/html");
				response.end("<h1>Static</h1>");
			} else {
				next();
			}
		};
		const internals = serverInternals(app);
		const logger = { log: () => {} };
		await internals?.prepare({
			...(await productionSetup({ logger })),
			mode: "development",
			devServer: devServerStage(viteMiddleware),
		});
		const server = await internals?.listen(stubFramework(), []);

		const headersOf = async (path: string) => {
			const response = await fetch(new URL(path, server?.urls[0]));
			await response.text();
			return {
				csp: response.headers.get("Content-Security-Policy"),
				build: response.headers.get("X-Build-Id"),
			};
		};
		const expected = { csp: "script-src 'self', frame-ancestors 'none'", build: "v1" };

		try {
			await expect(headersOf("/rendered")).resolves.toStrictEqual(expected);
			await expect(headersOf("/set.html")).resolves.toStrictEqual(expected);
			await expect(headersOf("/array.html")).resolves.toStrictEqual(expected);
		} finally {
			await server?.shutdown();
		}
	});
});
