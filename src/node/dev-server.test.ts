import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { getRequestListener } from "@hono/node-server";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createServer, serverInternals } from "../core/create-server.js";
import { accessLog } from "../core/plugins/access-log.js";
import { withHeaderHook } from "../core/header-hook.js";
import { bodyLimit } from "../core/plugins/body-limit.js";
import { buildId } from "../core/plugins/build-id.js";
import { noindex } from "../core/plugins/noindex.js";
import { contentSecurityPolicy, securityHeaders } from "../core/plugins/security-headers.js";
import { requestId } from "../core/plugins/request-id.js";
import { assets } from "../core/plugins/static.js";
import { onResponseSent } from "../core/response-edge.js";
import type { Listener, Plugin } from "../core/types.js";
import type { LoggedLine } from "../test-server.js";
import { productionSetup, stubFramework } from "../test-server.js";
import { devServerStage } from "./dev-server.js";
import type { NodeMiddleware } from "./dev-server.js";
import { tcp } from "./tcp.js";

/** What a listener reported for a response, as the access log reads it. */
type Report = { status: number; bytes: number; requestId: string | null };

/** A stage that records the report of each response into `reports`. */
function sentRecorder(reports: Report[]): Plugin {
	return {
		name: "sent-recorder",
		middleware: async (context, next) => {
			await next();
			onResponseSent(context, ({ status, bytes, headers }) => {
				reports.push({ status, bytes, requestId: headers.get("X-Request-Id") });
			});
		},
	};
}

/**
 * A listener that gives each request its Node.js request and response but no
 * edge, as `@hono/node-server` does on Bun and Deno.
 */
function noEdgeListener(): Listener {
	return {
		name: "no-edge",
		start: async (fetch) => {
			const listener = getRequestListener(async (request, { incoming, outgoing }) =>
				fetch(request, { remoteAddress: incoming.socket.remoteAddress, incoming, outgoing }),
			);
			const server = createHttpServer((incoming, outgoing) => {
				void listener(incoming, outgoing);
			});
			await new Promise<void>((resolve) => {
				server.listen(0, "127.0.0.1", resolve);
			});
			const { port } = server.address() as AddressInfo;
			return {
				url: `http://127.0.0.1:${port}`,
				stop: async () =>
					new Promise<void>((resolve) => {
						server.closeAllConnections();
						server.close(() => {
							resolve();
						});
					}),
			};
		},
	};
}

describe("devServerStage", () => {
	it("gives an HTML file of the public directory the CSP with its script hashes, for a 304 too", async () => {
		const publicDirectory = mkdtempSync(join(tmpdir(), "app-server-public-"));
		onTestFinished(() => {
			rmSync(publicDirectory, { recursive: true, force: true });
		});
		mkdirSync(join(publicDirectory, "docs"));
		writeFileSync(join(publicDirectory, "docs/offline.html"), "<script>go()</script>");
		const app = createServer({
			plugins: [
				contentSecurityPolicy({ policy: (scriptSrc) => `script-src ${scriptSrc}` }),
				assets(),
			],
			logger: { log: () => {} },
			listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		});
		const viteMiddleware: NodeMiddleware = (request, response) => {
			if (request.headers["if-none-match"] != null) {
				response.statusCode = 304;
				response.end();
				return;
			}
			response.setHeader("Content-Type", "text/html");
			response.end("<script>go()</script>");
		};
		const internals = serverInternals(app);
		await internals?.prepare({
			...(await productionSetup({ logger: { log: () => {} } })),
			mode: "development",
			devServer: devServerStage(viteMiddleware, {
				publicFiles: () => ({ directory: publicDirectory, base: "/" }),
			}),
		});
		const server = await internals?.listen(stubFramework(), []);
		const url = new URL("/docs/offline.html", server?.urls[0]);

		const ok = await fetch(url);
		const notModified = await fetch(url, { headers: { "If-None-Match": 'W/"1"' } });
		const notPublic = await fetch(new URL("/other.html", server?.urls[0]));
		await server?.shutdown();

		const policy = "script-src 'self' 'sha256-5KYv+PUboo5h+0+YAtGRPbwv5d/QxzHslP4YGnUaxRw='";
		expect(ok.headers.get("Content-Security-Policy")).toBe(policy);
		expect(notModified.status).toBe(304);
		expect(notModified.headers.get("Content-Security-Policy")).toBe(policy);
		expect(notPublic.headers.get("Content-Security-Policy")).toMatch(/^script-src 'nonce-/u);
	});

	it("finds the public file with or without Vite's base, and keeps the nonce policy when the middleware passes", async () => {
		const publicDirectory = mkdtempSync(join(tmpdir(), "app-server-public-"));
		onTestFinished(() => {
			rmSync(publicDirectory, { recursive: true, force: true });
		});
		writeFileSync(join(publicDirectory, "offline.html"), "<script>go()</script>");
		const app = createServer({
			plugins: [
				contentSecurityPolicy({ policy: (scriptSrc) => `script-src ${scriptSrc}` }),
				assets(),
			],
			logger: { log: () => {} },
			listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		});
		const viteMiddleware: NodeMiddleware = (request, response, next) => {
			if (request.method === "POST") {
				next();
				return;
			}
			response.setHeader("Content-Type", "text/html");
			response.end("<script>go()</script>");
		};
		const internals = serverInternals(app);
		await internals?.prepare({
			...(await productionSetup({ logger: { log: () => {} } })),
			mode: "development",
			devServer: devServerStage(viteMiddleware, {
				publicFiles: () => ({ directory: publicDirectory, base: "/docs/" }),
			}),
		});
		const server = await internals?.listen(stubFramework(), []);
		const url = new URL("/docs/offline.html", server?.urls[0]);

		const served = await fetch(url);
		const noBase = await fetch(new URL("/offline.html", server?.urls[0]));
		const passed = await fetch(url, { method: "POST" });
		await server?.shutdown();

		const policy = "script-src 'self' 'sha256-5KYv+PUboo5h+0+YAtGRPbwv5d/QxzHslP4YGnUaxRw='";
		expect(served.headers.get("Content-Security-Policy")).toBe(policy);
		expect(noBase.headers.get("Content-Security-Policy")).toBe(policy);
		expect(passed.headers.get("Content-Security-Policy")).toMatch(/^script-src 'nonce-/u);
	});

	it("sends the request ID with the middleware's answer, reports its status and length, and writes no access line", async () => {
		const lines: LoggedLine[] = [];
		const reports: Report[] = [];
		const app = createServer({
			plugins: [requestId(), accessLog(), sentRecorder(reports), assets()],
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
		expect(reports).toStrictEqual([{ status: 418, bytes: 6, requestId: "abc-123" }]);
		expect(lines.filter((line) => line.message === "request")).toStrictEqual([]);
	});

	it.each([
		{ host: "the node host", listener: () => tcp({ port: 0, host: "127.0.0.1" }) },
		{ host: "a listener with no edge, as on Bun and Deno", listener: noEdgeListener },
	])(
		"reports the headers that the middleware sent and no body bytes for HEAD, with $host",
		async ({ listener }) => {
			const reports: Report[] = [];
			const app = createServer({
				plugins: [requestId(), sentRecorder(reports), assets()],
				logger: { log: () => {} },
				listeners: [listener()],
			});
			const middleware: NodeMiddleware = (_, response) => {
				response.statusCode = 418;
				response.setHeader("Content-Length", "6");
				response.end("teapot");
			};
			const internals = serverInternals(app);
			await internals?.prepare({
				...(await productionSetup({ logger: { log: () => {} } })),
				mode: "development",
				devServer: devServerStage(middleware),
			});
			const server = await internals?.listen(stubFramework(), []);
			onTestFinished(async () => server?.shutdown());

			const head = await fetch(new URL("/@vite/client", server?.urls[0]), {
				method: "HEAD",
				headers: { "X-Request-Id": "abc-123" },
			});

			expect([head.status, head.headers.get("X-Request-Id")]).toStrictEqual([418, "abc-123"]);
			await vi.waitFor(() => {
				expect(reports).toStrictEqual([{ status: 418, bytes: 0, requestId: "abc-123" }]);
			});
		},
	);

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

	it("runs each header hook once for an answer of the middleware", async () => {
		let calls = 0;
		const counted: Plugin = {
			name: "counted",
			middleware: async (context, next) =>
				withHeaderHook(context, next, (response) => {
					calls += 1;
					response.set("X-Calls", String(calls));
				}),
		};
		const app = createServer({
			plugins: [counted, assets()],
			logger: { log: () => {} },
			listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		});
		const viteMiddleware: NodeMiddleware = (_request, response) => {
			response.setHeader("Content-Type", "text/html");
			response.end("<h1>Static</h1>");
		};
		const internals = serverInternals(app);
		await internals?.prepare({
			...(await productionSetup({ logger: { log: () => {} } })),
			mode: "development",
			devServer: devServerStage(viteMiddleware),
		});
		const server = await internals?.listen(stubFramework(), []);
		onTestFinished(async () => server?.shutdown());

		const response = await fetch(new URL("/static.html", server?.urls[0]));
		await response.text();

		expect([response.headers.get("X-Calls"), calls]).toStrictEqual(["1", 1]);
	});

	it("lets a header hook delete a header of the middleware's answer", async () => {
		const app = createServer({
			plugins: [buildId({ value: "v42" }), assets()],
			logger: { log: () => {} },
			listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		});
		const viteMiddleware: NodeMiddleware = (_request, response) => {
			response.setHeader("X-Build-Id", "api-v7");
			response.setHeader("Server-Timing", 'build;desc="api-v7"');
			response.end("{}");
		};
		const internals = serverInternals(app);
		await internals?.prepare({
			...(await productionSetup({ logger: { log: () => {} } })),
			mode: "development",
			devServer: devServerStage(viteMiddleware),
		});
		const server = await internals?.listen(stubFramework(), []);

		try {
			const response = await fetch(new URL("/@vite/client", server?.urls[0]));
			await response.text();

			expect(response.headers.get("X-Build-Id")).toBeNull();
			expect(response.headers.get("Server-Timing")).toBeNull();
		} finally {
			await server?.shutdown();
		}
	});
});
