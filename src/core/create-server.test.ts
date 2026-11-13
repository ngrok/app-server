import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createServer, defaultPlugins, serverInternals } from "./create-server.js";
import type { AppServer } from "./create-server.js";
import { eventStream } from "./event-stream.js";
import { withHeaderHook } from "./header-hook.js";
import { ResponseEdge } from "./response-edge.js";
import { renewShutdownSignal } from "./shutdown.js";
import { accessLog } from "./plugins/access-log.js";
import { buildId } from "./plugins/build-id.js";
import { health } from "./plugins/health.js";
import { noindex } from "./plugins/noindex.js";
import { requestId } from "./plugins/request-id.js";
import { runtimeEnv } from "./plugins/runtime-env.js";
import { prerendered as prerenderedPlugin } from "./plugins/static.js";
import { tcp } from "../node/tcp.js";
import { productionSetup, renderedFramework, stubFramework, testServer } from "../test-server.js";
import type { LoggedLine } from "../test-server.js";
import type { FrameworkRuntime, Listener, LogSink, Plugin, StartedListener } from "./types.js";

/** Starts an app on a free local port with the default plugins. */
async function listening(
	render: FrameworkRuntime["fetch"],
	plugins: Plugin[] = defaultPlugins(),
	{
		logger = { log: () => {} },
		clientDirectory,
		routes,
		...options
	}: {
		trustForwardedProto?: boolean;
		logger?: LogSink;
		clientDirectory?: string;
		routes?: (app: AppServer) => void;
	} = {},
) {
	const app = createServer({
		...options,
		plugins,
		logger,
		listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		shutdownDeadlineMs: 2_000,
	});
	routes?.(app);
	const internals = serverInternals(app);
	if (internals == null) {
		throw new Error("createServer returned an app with no internals.");
	}
	await internals.prepare(
		await productionSetup({ logger, ...(clientDirectory == null ? {} : { clientDirectory }) }),
	);
	return internals.listen(stubFramework(render), []);
}

describe("createServer", () => {
	it("runs the app's own routes before the framework", async () => {
		const { request } = await testServer({
			plugins: [],
			routes: (app) => {
				app.get("/livez", (context) => context.text("ok"));
			},
		});

		await expect((await request("/livez")).text()).resolves.toBe("ok");
		await expect((await request("/page")).text()).resolves.toBe("rendered");
	});

	it("runs plugins in list order, around the framework", async () => {
		const order: string[] = [];
		const step = (name: string): Plugin => ({
			name,
			middleware: async (_context, next) => {
				order.push(`${name} in`);
				await next();
				order.push(`${name} out`);
			},
		});
		const { request } = await testServer({ plugins: [step("first"), step("second")] });

		await request("/");

		expect(order).toStrictEqual(["first in", "second in", "second out", "first out"]);
	});

	it("reads the scheme from X-Forwarded-Proto only when trustForwardedProto is set", async () => {
		const render = async (request: Request) =>
			new Response(`${new URL(request.url).protocol} ${await request.text()}`);
		const routes = (app: AppServer) => {
			app.get("/route", (context) => context.text(new URL(context.req.url).protocol));
		};
		const headers = { "X-Forwarded-Proto": "https" };
		const init = { method: "POST", body: "form", headers };
		const trusted = await testServer({
			plugins: [],
			render,
			routes,
			options: { trustForwardedProto: true },
		});
		const untrusted = await testServer({ plugins: [], render, routes });

		await expect((await trusted.request("/", init)).text()).resolves.toBe("https: form");
		await expect((await trusted.request("/route", { headers })).text()).resolves.toBe("https:");
		await expect((await untrusted.request("/", init)).text()).resolves.toBe("http: form");
		await expect((await untrusted.request("/route", { headers })).text()).resolves.toBe("http:");
	});

	it("answers an HTTPException with its own response, not a 500", async () => {
		const { request, lines } = await testServer({
			plugins: [],
			routes: (app) => {
				app.use("/admin", basicAuth({ username: "admin", password: "secret" }));
			},
		});

		const response = await request("/admin");

		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain("Basic");
		expect(lines).toStrictEqual([]);
	});

	it("cancels the body of a HEAD response, so a stream stops", async () => {
		const cancel = vi.fn<(reason: unknown) => void>();
		const { request } = await testServer({
			plugins: defaultPlugins(),
			render: async () => new Response(new ReadableStream({ cancel })),
		});

		await request("/events", { method: "HEAD" });

		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("sends the security headers with a 413 from the body limit", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins({ bodyLimit: 10 }),
			render: async (incoming) => new Response(await incoming.arrayBuffer()),
		});

		const declared = await request("/upload", {
			method: "POST",
			headers: { "Content-Length": "11" },
			body: "x".repeat(11),
		});
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			duplex: "half",
			body: new Blob(["x".repeat(11)]).stream(),
		};
		const streamed = await request("/upload", init);

		for (const response of [declared, streamed]) {
			expect(response.status).toBe(413);
			expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		}
	});

	it("adds its headers to a response whose headers are immutable", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins(),
			routes: (app) => {
				app.get("/moved", () => Response.redirect("https://example.com/", 302));
			},
		});

		const response = await request("/moved", { headers: { "Accept-Encoding": "gzip" } });

		expect(response.status).toBe(302);
		expect(response.headers.get("X-Request-Id")).not.toBeNull();
		expect(response.headers.get("Vary")).toBe("Accept-Encoding");
	});

	it("leaves a response object that the app sends again unchanged", async () => {
		const shared = new Response(null, { status: 204 });
		const { request } = await testServer({
			plugins: defaultPlugins(),
			routes: (app) => {
				app.get("/empty", () => shared);
			},
		});

		const first = await request("/empty", { headers: { "X-Request-Id": "first" } });
		const second = await request("/empty", { headers: { "X-Request-Id": "second" } });

		expect(first.headers.get("X-Request-Id")).toBe("first");
		expect(second.headers.get("X-Request-Id")).toBe("second");
		expect([...shared.headers.keys()]).toStrictEqual([]);
	});

	it("marks a rendered document private by default, but not a prerendered page", async () => {
		const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-private-"));
		onTestFinished(() => {
			rmSync(clientDirectory, { recursive: true, force: true });
		});
		writeFileSync(join(clientDirectory, "about.html"), "<h1>About</h1>");
		const { request } = await testServer({ plugins: defaultPlugins(), clientDirectory });

		const rendered = await request("/dashboard");
		const prerendered = await request("/about.html");

		expect(rendered.headers.get("Cache-Control")).toBe("private, no-cache");
		expect(prerendered.headers.get("Cache-Control")).not.toBe("private, no-cache");
	});

	it("logs the client address from X-Forwarded-For with trustedProxyHops", async () => {
		const logged = async (trustedProxyHops: number, forwardedFor: string) => {
			const { request, lines } = await testServer({
				plugins: [accessLog()],
				options: { trustedProxyHops },
			});
			await (await request("/", { headers: { "X-Forwarded-For": forwardedFor } })).text();
			return lines[0]?.attributes["network.client.ip"];
		};

		await expect(logged(1, "1.1.1.1, 2.2.2.2")).resolves.toBe("2.2.2.2");
		await expect(logged(2, "1.1.1.1, 2.2.2.2")).resolves.toBe("1.1.1.1");
		await expect(logged(3, "1.1.1.1, 2.2.2.2")).resolves.toBe("1.1.1.1");
		await expect(logged(0, "1.1.1.1, 2.2.2.2")).resolves.toBeUndefined();
	});

	it("stops startup for a trustedProxyHops that is not a count", () => {
		expect(() => createServer({ trustedProxyHops: Number.NaN })).toThrow(
			"trustedProxyHops must be an integer of 0 or more, not NaN.",
		);
	});

	it("stops startup for a shutdown time that a timer cannot hold", () => {
		for (const shutdownDeadlineMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
			expect(() => createServer({ shutdownDeadlineMs })).toThrow(
				"shutdownDeadlineMs must be an integer from 0 to 2147483647",
			);
		}
		expect(() => createServer({ shutdownDelayMs: 2_147_483_648 })).toThrow(
			"shutdownDelayMs must be an integer from 0 to 2147483647",
		);
	});

	it("stops startup for a function in the plugin list, and names the fix", () => {
		// @ts-expect-error -- a Hono middleware is not a plugin: an object with a name holds it.
		const bare: Plugin = basicAuth({ username: "admin", password: "secret" });
		// @ts-expect-error -- the app must call the plugin factory.
		const uncalled: Plugin = requestId;

		expect(() => createServer({ plugins: defaultPlugins({ beforeStatic: [bare] }) })).toThrow(
			'plugins[7] is the function basicAuth, not a plugin. Call a plugin factory, such as requestId(). Put a Hono middleware in a plugin, such as { name: "auth", middleware: basicAuth() }.',
		);
		expect(() => createServer({ plugins: [health(), uncalled] })).toThrow(
			"plugins[1] is the function requestId, not a plugin.",
		);
		expect(() => createServer({ plugins: [(() => {}) as unknown as Plugin] })).toThrow(
			"plugins[0] is a function, not a plugin.",
		);
	});

	it.each([undefined, null, false, "requestId"])(
		"stops startup for %j in the plugin list, and names the fix",
		(value) => {
			expect(() => createServer({ plugins: [value as unknown as Plugin] })).toThrow(
				`plugins[0] is ${String(value)}, not a plugin. Remove it. To add a plugin on a condition, spread a list: ...(condition ? [plugin] : []).`,
			);
		},
	);

	it("runs a Hono middleware that a plugin holds", async () => {
		const auth: Plugin = {
			name: "basic-auth",
			middleware: basicAuth({ username: "admin", password: "secret" }),
		};
		const { request } = await testServer({ plugins: defaultPlugins({ beforeStatic: [auth] }) });

		const response = await request("/secret");

		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain("Basic");
	});

	it("logs an unhandled error with its cause and answers 500", async () => {
		const { request, lines } = await testServer({
			plugins: [],
			render: async () => {
				throw new TypeError("boom", { cause: Object.assign(new Error("refused"), { code: 61 }) });
			},
		});

		const response = await request("/");

		expect(response.status).toBe(500);
		expect(lines).toStrictEqual([
			{
				level: "error",
				message: "unhandled error",
				attributes: expect.objectContaining({
					"error.kind": "TypeError",
					"error.message": "boom",
					"error.cause.message": "refused",
					"error.cause.code": 61,
				}),
			},
		]);
	});

	it.each([
		["a string", "boom"],
		["null", null],
	])(
		"logs %s that a route throws, answers 500, and still writes the access line",
		async (_, thrown) => {
			const { request, lines } = await testServer({
				plugins: [accessLog()],
				routes: (app) => {
					app.get("/throws", () => {
						// oxlint-disable-next-line typescript/only-throw-error -- the test throws a value that is not an Error on purpose.
						throw thrown;
					});
				},
			});

			const response = await request("/throws");
			await response.text();

			expect(response.status).toBe(500);
			expect(lines).toStrictEqual([
				{
					level: "error",
					message: "unhandled error",
					attributes: expect.objectContaining({
						"error.message": `A non-Error value was thrown: ${String(thrown)}`,
					}),
				},
				{
					level: "error",
					message: "request",
					attributes: expect.objectContaining({ "http.status_code": 500 }),
				},
			]);
		},
	);

	it("answers a request that comes with no bindings, such as from `app.request`", async () => {
		const app = createServer({ plugins: defaultPlugins(), logger: { log: () => {} } });
		app.get("/api/status", (c) => c.json({ ok: true }));

		const response = await app.request("/api/status", { headers: { "X-Request-Id": "abc-123" } });

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toStrictEqual({ ok: true });
		expect(response.headers.get("X-Request-Id")).toBe("abc-123");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("answers 500 when a header hook throws, runs the outer hooks, and writes the access line", async () => {
		const throwsInHook: Plugin = {
			name: "throws-in-hook",
			middleware: async (context, next) =>
				withHeaderHook(context, next, () => {
					throw new Error("hook failed");
				}),
		};
		const { request, lines } = await testServer({
			plugins: [requestId(), accessLog(), throwsInHook],
		});

		const response = await request("/", { headers: { "X-Request-Id": "abc-123" } });
		await response.text();

		expect(response.status).toBe(500);
		expect(response.headers.get("X-Request-Id")).toBe("abc-123");
		expect(lines.map(({ message }) => message)).toStrictEqual(["unhandled error", "request"]);
		expect(lines[1]?.attributes).toMatchObject({ "http.status_code": 500 });
	});

	it("answers a header hook that throws with the app's onError, as a stage that throws", async () => {
		const throwsInHook: Plugin = {
			name: "throws-in-hook",
			middleware: async (context, next) =>
				withHeaderHook(context, next, () => {
					throw new Error("hook failed");
				}),
		};
		const { request } = await testServer({
			plugins: [throwsInHook],
			routes: (app) => {
				app.onError(async (error, context) => context.text(`custom: ${error.message}`, 503));
			},
		});

		const response = await request("/");

		expect([response.status, await response.text()]).toStrictEqual([503, "custom: hook failed"]);
	});

	it("starts the tcp listener when a caller gives no start options", async () => {
		const started = await tcp({ port: 0, host: "127.0.0.1" }).start(async () => new Response("ok"));
		onTestFinished(async () => started.stop({ deadlineMs: 0 }));

		const response = await fetch(started.url);

		await expect(response.text()).resolves.toBe("ok");
	});

	it("writes the access line when a later plugin throws a value that is not an Error", async () => {
		const thrower: Plugin = {
			name: "thrower",
			middleware: () => {
				// oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- the test throws a string on purpose.
				throw "boom";
			},
		};
		const { request, lines } = await testServer({ plugins: [accessLog(), thrower] });

		const response = await request("/");
		await response.text();

		expect(response.status).toBe(500);
		expect(lines.map(({ message }) => message)).toStrictEqual(["unhandled error", "request"]);
	});

	it("sends a small body from a string with its Content-Length through gzip on the Node listener", async () => {
		const server = await listening(
			async () => new Response("pong", { headers: { "Content-Type": "text/plain" } }),
		);

		const headers = await new Promise<Record<string, unknown>>((resolve, reject) => {
			httpRequest(server.urls[0] ?? "", { headers: { "Accept-Encoding": "gzip" } }, (response) => {
				response.resume();
				resolve(response.headers);
			})
				.on("error", reject)
				.end();
		});

		expect(headers["content-length"]).toBe("4");
		expect(headers["transfer-encoding"]).toBeUndefined();
		await server.shutdown();
	});

	it("stops the handler's stream when the client disconnects through gzip and the access log", async () => {
		const cancel = vi.fn<(reason: unknown) => void>();
		const server = await listening(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("shell"));
						},
						cancel,
					}),
					{ headers: { "Content-Type": "text/html" } },
				),
		);
		const url = server.urls[0] ?? "";

		await new Promise<void>((resolve, reject) => {
			const request = httpRequest(url, { headers: { "Accept-Encoding": "gzip" } }, (response) => {
				response.once("data", () => {
					request.destroy();
					resolve();
				});
			});
			request.on("error", (error) => {
				if (!request.destroyed) {
					reject(error);
				}
			});
			request.end();
		});

		await expect.poll(() => cancel.mock.calls.length).toBe(1);
		await server.shutdown();
	});

	it("stops the handler's stream when the client disconnects before the response is ready", async () => {
		const cancel = vi.fn<(reason: unknown) => void>();
		const entered = Promise.withResolvers<undefined>();
		const server = await listening(async (incoming) => {
			entered.resolve(undefined);
			// Why wait for the abort: the response must come after the server sees the disconnect.
			await new Promise((resolve) => {
				incoming.signal.addEventListener("abort", resolve, { once: true });
			});
			return new Response(new ReadableStream<Uint8Array>({ cancel }), {
				headers: { "Content-Type": "text/plain" },
			});
		});

		const request = httpRequest(server.urls[0] ?? "");
		request.on("error", () => {});
		request.end();
		await entered.promise;
		request.destroy();

		await expect.poll(() => cancel.mock.calls.length).toBe(1);
		await server.shutdown();
	});

	it("keeps a `fetch()` result an `instanceof Response` in a route on the Node listener", async () => {
		const server = await listening(async () => {
			const fetched = await fetch("data:text/plain,upstream");
			return new Response(String(fetched instanceof Response));
		});

		const response = await fetch(server.urls[0] ?? "");

		await expect(response.text()).resolves.toBe("true");
		await server.shutdown();
	});

	it("copies an incoming request with `new Request` in a route on the Node listener", async () => {
		const server = await listening(async (request) => {
			const copy = new Request(request, { method: "DELETE" });
			return new Response(`${copy.method} ${new URL(copy.url).pathname}`);
		});

		const response = await fetch(new URL("/items", server.urls[0]));

		await expect(response.text()).resolves.toBe("DELETE /items");
		await server.shutdown();
	});

	it("keeps the TRACE method when it reads the scheme from X-Forwarded-Proto on the Node listener", async () => {
		const server = await listening(
			async (request) => new Response(`${request.method} ${new URL(request.url).protocol}`),
			[],
			{ trustForwardedProto: true },
		);

		const body = await new Promise<string>((resolve, reject) => {
			const outgoing = httpRequest(server.urls[0] ?? "", {
				method: "TRACE",
				headers: { "X-Forwarded-Proto": "https" },
			});
			outgoing.on("response", (incoming) => {
				incoming.setEncoding("utf8");
				let text = "";
				incoming.on("data", (chunk: string) => {
					text += chunk;
				});
				incoming.on("end", () => {
					resolve(text);
				});
			});
			outgoing.on("error", reject);
			outgoing.end();
		});

		expect(body).toBe("TRACE https:");
		await server.shutdown();
	});

	it("reads the scheme from X-Forwarded-Proto for a request with a body on the Node listener", async () => {
		const server = await listening(
			async (request) => new Response(`${new URL(request.url).protocol} ${await request.text()}`),
			[],
			{ trustForwardedProto: true },
		);

		const response = await fetch(server.urls[0] ?? "", {
			method: "POST",
			body: "form",
			headers: { "X-Forwarded-Proto": "https" },
		});

		await expect(response.text()).resolves.toBe("https: form");
		await server.shutdown();
	});

	it("ends an open event stream at shutdown and drains before the deadline", async () => {
		const onShutdown = vi.fn<() => Promise<void>>(async () => {});
		const server = await listening(
			async () =>
				eventStream({}, async ({ send }) => {
					send({ data: "hello" });
					return new Promise(() => {});
				}),
			[...defaultPlugins(), { name: "shutdown-probe", onShutdown }],
		);
		const response = await fetch(server.urls[0] ?? "");
		const reader = response.body?.getReader();
		const decoder = new TextDecoder();
		let first = "";
		// Why a loop: the gzip decoder can hand back an empty chunk first.
		for (
			let chunk = await reader?.read();
			chunk != null && !chunk.done;
			chunk = await reader?.read()
		) {
			first += decoder.decode(chunk.value);
			if (first.endsWith("\n\n")) {
				break;
			}
		}

		const shutdown = server.shutdown();
		let rest = "";
		for (
			let chunk = await reader?.read();
			chunk != null && !chunk.done;
			chunk = await reader?.read()
		) {
			rest += decoder.decode(chunk.value);
		}
		await shutdown;

		expect(first).toBe("data: hello\n\n");
		expect(rest).toBe("");
		expect(onShutdown).toHaveBeenCalledTimes(1);
	});

	it.each<{ failure: string; start: Listener["start"] }>([
		{
			failure: "rejects",
			start: async () => {
				throw new Error("address in use");
			},
		},
		{
			failure: "throws before it returns a promise",
			start: () => {
				throw new Error("address in use");
			},
		},
	])("stops the started listeners when another listener $failure", async ({ start }) => {
		const stop = vi.fn<StartedListener["stop"]>(async () => {});
		const app = createServer({
			plugins: [],
			logger: { log: () => {} },
			listeners: [
				{ name: "ok", start: async () => ({ url: "http://localhost:1", stop }) },
				{ name: "taken", start },
			],
		});

		await expect(serverInternals(app)?.listen(stubFramework(), [])).rejects.toThrow(
			"address in use",
		);
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("finishes the other stops before it rejects for a listener that fails to stop", async () => {
		const finished: string[] = [];
		const app = createServer({
			plugins: [
				{
					name: "slow-hook",
					onShutdown: async () => {
						await sleep(50);
						finished.push("hook");
					},
				},
			],
			logger: { log: () => {} },
			listeners: [
				{
					name: "broken",
					start: async () => ({
						url: "http://localhost:1",
						stop: async () => {
							throw new Error("stop failed");
						},
					}),
				},
			],
		});
		const internals = serverInternals(app);
		const server = await internals?.listen(stubFramework(), []);

		await expect(server?.shutdown()).rejects.toThrow("stop failed");
		expect(finished).toStrictEqual(["hook"]);
	});

	it("stops the listeners at the deadline when a plugin's onShutdown hangs", async () => {
		const server = await listening(renderedFramework, [
			{ name: "stuck", onShutdown: async () => new Promise(() => {}) },
		]);

		await server.shutdown();

		await expect(fetch(server.urls[0] ?? "")).rejects.toThrow("fetch failed");
	});

	it("gives each request a logger whose methods write a line when taken off it", async () => {
		const { request, lines } = await testServer({
			plugins: [requestId()],
			render: async (_request, context) => {
				const { info } = context.get("logger");
				info("loading", { "app.step": 1 });
				return new Response("ok");
			},
		});

		await (await request("/", { headers: { "X-Request-Id": "abc-123" } })).text();

		expect(lines).toStrictEqual([
			{
				level: "info",
				message: "loading",
				attributes: {
					"http.request_id": "abc-123",
					"http.method": "GET",
					"http.url_details.path": "/",
					"app.step": 1,
				},
			},
		]);
	});
});

describe("defaultPlugins", () => {
	const theme = "document.documentElement.dataset.theme = 'dark';";
	const themeHash = createHash("sha256").update(theme).digest("base64");
	const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-defaults-"));
	mkdirSync(join(clientDirectory, "about"));
	writeFileSync(
		join(clientDirectory, "about/index.html"),
		`<html><head><script>${theme}</script></head><body>About</body></html>`,
	);
	writeFileSync(
		join(clientDirectory, ".app-server.json"),
		JSON.stringify({
			buildId: "build-from-vite",
			prerendered: ["/about"],
			headers: {},
			scriptHashes: { "/about/index.html": [themeHash] },
		}),
	);

	afterAll(() => {
		rmSync(clientDirectory, { recursive: true, force: true });
	});
	const env = runtimeEnv(z.object({ PUBLIC_REGION: z.string() }), {
		source: { PUBLIC_REGION: "eu" },
	});

	it("answers the liveness and readiness probes by default", async () => {
		// Why: a shutdown test above marks the process as stopping.
		renewShutdownSignal();
		const { request } = await testServer({ plugins: defaultPlugins(), clientDirectory });

		const live = await request("/livez");
		const ready = await request("/readyz");

		expect([live.status, await live.text()]).toStrictEqual([200, "ok"]);
		expect([ready.status, await ready.text()]).toStrictEqual([200, "ok"]);
	});

	it("leaves /livez and /readyz to the app with health: false", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins({ health: false }),
			clientDirectory,
		});

		await expect((await request("/livez")).text()).resolves.toBe("rendered");
		await expect((await request("/readyz")).text()).resolves.toBe("rendered");
	});

	it("gives a prerendered page the CSP of the contentSecurityPolicy option", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins({
				contentSecurityPolicy: { policy: ({ scriptSrc }) => `script-src ${scriptSrc}` },
			}),
			clientDirectory,
		});

		const page = await request("/about");

		await expect(page.text()).resolves.toContain("About");
		expect(page.headers.get("Content-Security-Policy")).toBe(
			`script-src 'self' 'sha256-${themeHash}'`,
		);
	});

	it("writes the public env values and the noindex header on a prerendered page", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins({ env, noindex: true }),
			clientDirectory,
		});

		const page = await request("/about");

		await expect(page.text()).resolves.toContain('{"PUBLIC_REGION":"eu"}');
		expect(page.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
	});

	it("gives the app's beforeStatic plugins the CSP nonce, and adds the headers to their responses", async () => {
		const login: Plugin = {
			name: "login",
			middleware: async (c) => c.html(`<script nonce="${c.get("cspNonce") ?? ""}"></script>`, 401),
		};
		const { request } = await testServer({
			plugins: defaultPlugins({
				noindex: true,
				contentSecurityPolicy: { policy: ({ scriptSrc }) => `script-src ${scriptSrc}` },
				beforeStatic: [login],
			}),
			clientDirectory,
		});

		const response = await request("/about");
		const nonce = /nonce="(?<nonce>[^"]+)"/u.exec(await response.text())?.groups?.nonce ?? "";

		expect(nonce).not.toBe("");
		expect(response.headers.get("Content-Security-Policy")).toBe(
			`script-src 'nonce-${nonce}' 'strict-dynamic'`,
		);
		expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
	});

	it("sends the build ID from the build by default, on prerendered and rendered documents", async () => {
		const { request } = await testServer({ plugins: defaultPlugins(), clientDirectory });

		const prerendered = await request("/about");
		const rendered = await request("/dashboard");

		expect(prerendered.headers.get("X-Build-Id")).toBe("build-from-vite");
		expect(prerendered.headers.get("Server-Timing")).toBe('build;desc="build-from-vite"');
		expect(rendered.headers.get("X-Build-Id")).toBe("build-from-vite");
	});

	it("sends an explicit build ID in place of the build's", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins({ buildId: { value: "v42" } }),
			clientDirectory,
		});

		expect((await request("/about")).headers.get("X-Build-Id")).toBe("v42");
	});

	it("sends the build's ID for an empty value, such as an empty variable", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins({ buildId: { value: "" } }),
			clientDirectory,
		});

		expect((await request("/about")).headers.get("X-Build-Id")).toBe("build-from-vite");
	});

	it("sends no build ID with buildId: false", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins({ buildId: false }),
			clientDirectory,
		});

		expect((await request("/about")).headers.get("X-Build-Id")).toBeNull();
	});

	it("stops startup for two plugins of one option, anywhere in the list", () => {
		expect(() =>
			createServer({ plugins: defaultPlugins({ beforeStatic: [buildId({ value: "v42" })] }) }),
		).toThrow("the build-id plugin two times");
		expect(() => createServer({ plugins: [...defaultPlugins(), health()] })).toThrow(
			'set the "health" option of defaultPlugins()',
		);
		expect(() => createServer({ plugins: [...defaultPlugins({ env }), env] })).toThrow(
			'set the "env" option',
		);
	});

	it("takes an app plugin that has the name of an option plugin", () => {
		const own: Plugin = { name: "health" };

		expect(() =>
			createServer({ plugins: defaultPlugins({ noindex: true, beforeStatic: [own, noindex()] }) }),
		).toThrow("noindex");
		expect(() => createServer({ plugins: defaultPlugins({ beforeStatic: [own] }) })).not.toThrow();
		expect(() => createServer({ plugins: defaultPlugins({ beforeStatic: [env] }) })).not.toThrow();
	});

	it("takes an app plugin whose name is a property of every object, such as constructor", () => {
		expect(defaultPlugins({ beforeStatic: [{ name: "constructor" }] })).toContainEqual({
			name: "constructor",
		});
	});
});

describe("the pipeline", () => {
	const about = `<!doctype html><title>about</title>${"<p>x</p>".repeat(300)}`;
	const script = "console.log(1);".repeat(200);
	const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-pipeline-"));
	mkdirSync(join(clientDirectory, "about"));
	mkdirSync(join(clientDirectory, "assets"));
	writeFileSync(join(clientDirectory, "about/index.html"), about);
	writeFileSync(join(clientDirectory, "assets/app-abc.js"), script);
	writeFileSync(
		join(clientDirectory, ".app-server.json"),
		JSON.stringify({
			buildId: "build-123",
			prerendered: ["/about"],
			headers: {},
			scriptHashes: {},
		}),
	);

	afterAll(() => {
		rmSync(clientDirectory, { recursive: true, force: true });
	});

	type Stages = Omit<Parameters<typeof testServer>[0], "plugins"> & { plugins?: Plugin[] };

	/**
	 * A server with `requestId()`, `accessLog()`, and a plugin that records what
	 * it sees after its `next()`: the status, and the message of `c.error`. The
	 * `plugins` come after them.
	 */
	async function pipeline({ plugins = [], ...rest }: Stages = {}) {
		const seen: string[] = [];
		const spy: Plugin = {
			name: "spy",
			middleware: async (context, next) => {
				await next();
				seen.push(
					context.error == null
						? String(context.res.status)
						: `${context.res.status} ${context.error.message}`,
				);
			},
		};
		const server = await testServer({
			...rest,
			plugins: [requestId(), accessLog(), spy, ...plugins],
		});
		return { ...server, seen };
	}

	/** The message of each log line, with its status or its error message. */
	const summary = (lines: LoggedLine[]) =>
		lines.map(({ message, attributes }) => [
			message,
			attributes["http.status_code"] ?? attributes["error.message"],
		]);

	/** A pipeline whose stage at each place calls `fail`. */
	const throwsAt: Record<string, (fail: () => never) => Stages> = {
		"a plugin before next()": (fail) => ({
			plugins: [{ name: "thrower", middleware: async () => fail() }],
		}),
		"a plugin that is not async": (fail) => ({
			plugins: [{ name: "thrower", middleware: () => fail() }],
		}),
		"a plugin after next()": (fail) => ({
			plugins: [
				{
					name: "thrower",
					middleware: async (_context, next) => {
						await next();
						fail();
					},
				},
			],
		}),
		"a route": (fail) => ({
			routes: (app) => {
				app.get("/", () => fail());
			},
		}),
		"the framework": (fail) => ({ render: async () => fail() }),
	};

	const thrown: [what: string, value: unknown, message: string][] = [
		["a string", "boom", "A non-Error value was thrown: boom"],
		["null", null, "A non-Error value was thrown: null"],
		["an Error", new Error("bang"), "bang"],
	];

	it.each(
		thrown.flatMap(([what, value, message]) =>
			Object.keys(throwsAt).map((place) => ({ what, value, message, place })),
		),
	)(
		"answers 500 for $what that $place throws, logs it, and shows it to each earlier plugin",
		async ({ value, message, place }) => {
			const { request, lines, seen } = await pipeline(
				throwsAt[place]?.(() => {
					// oxlint-disable-next-line typescript/only-throw-error -- the test throws a value that is not an Error on purpose.
					throw value;
				}),
			);

			const response = await request("/", { headers: { "X-Request-Id": "abc-123" } });

			expect([response.status, await response.text()]).toStrictEqual([
				500,
				"Internal Server Error",
			]);
			expect(response.headers.get("X-Request-Id")).toBe("abc-123");
			expect(seen).toStrictEqual([`500 ${message}`]);
			expect(summary(lines)).toStrictEqual([
				["unhandled error", message],
				["request", 500],
			]);
		},
	);

	const exceptions: [what: string, make: () => Error][] = [
		["an HTTPException", () => new HTTPException(418, { message: "teapot" })],
		[
			"an HTTPException of another copy of Hono",
			() =>
				Object.assign(new Error("teapot"), {
					getResponse: () => new Response("teapot", { status: 418 }),
				}),
		],
	];

	it.each(
		exceptions.flatMap(([what, make]) =>
			["a plugin before next()", "a plugin after next()", "a route"].map((place) => ({
				what,
				make,
				place,
			})),
		),
	)(
		"answers $what that $place throws with its own response, and logs no error",
		async ({ make, place }) => {
			const { request, lines, seen } = await pipeline(
				throwsAt[place]?.(() => {
					throw make();
				}),
			);

			const response = await request("/");

			expect([response.status, await response.text()]).toStrictEqual([418, "teapot"]);
			expect(seen).toStrictEqual(["418 teapot"]);
			expect(summary(lines)).toStrictEqual([["request", 418]]);
		},
	);

	it.each([
		["an Error", new Error("down"), "down"],
		["a string", "down", "A non-Error value was thrown: down"],
	])(
		"answers %s that a plugin throws with the app's onError, and logs no error",
		async (_, value, message) => {
			const { request, lines, seen } = await pipeline({
				...throwsAt["a plugin before next()"]?.(() => {
					// oxlint-disable-next-line typescript/only-throw-error -- the test throws a value that is not an Error on purpose.
					throw value;
				}),
				routes: (app) => {
					app.onError(async (error, context) => context.json({ handled: error.message }, 503));
				},
			});

			const response = await request("/");

			expect([response.status, await response.json()]).toStrictEqual([503, { handled: message }]);
			expect(seen).toStrictEqual([`503 ${message}`]);
			expect(summary(lines)).toStrictEqual([["request", 503]]);
		},
	);

	it("rejects when the app's onError throws", async () => {
		const { request, lines, seen } = await pipeline({
			plugins: [
				{
					name: "thrower",
					middleware: async () => {
						throw new Error("down");
					},
				},
			],
			routes: (app) => {
				app.onError(() => {
					throw new Error("handler failed");
				});
			},
		});

		await expect(request("/")).rejects.toThrow("handler failed");
		expect(seen).toStrictEqual([]);
		expect(lines).toStrictEqual([]);
	});

	it("shows an earlier plugin the response of the later stages before a header hook throws", async () => {
		const { request, seen } = await pipeline({
			plugins: [
				{
					name: "throws-in-hook",
					middleware: async (context, next) =>
						withHeaderHook(context, next, () => {
							throw new Error("hook failed");
						}),
				},
			],
		});

		const response = await request("/");

		expect(response.status).toBe(500);
		expect(seen).toStrictEqual(["200"]);
	});

	it("stops at a plugin that answers, and runs no later stage", async () => {
		const render = vi.fn<FrameworkRuntime["fetch"]>(renderedFramework);
		const { request, lines, seen } = await pipeline({
			plugins: [{ name: "short", middleware: async (context) => context.text("short", 202) }],
			render,
		});

		const response = await request("/");

		expect([response.status, await response.text()]).toStrictEqual([202, "short"]);
		expect(render).toHaveBeenCalledTimes(0);
		expect(seen).toStrictEqual(["202"]);
		expect(summary(lines)).toStrictEqual([["request", 202]]);
	});

	it("answers 500 for a second next() in a plugin, and runs the later stages one time", async () => {
		const render = vi.fn<FrameworkRuntime["fetch"]>(renderedFramework);
		const { request, lines, seen } = await pipeline({
			plugins: [
				{
					name: "twice",
					middleware: async (_context, next) => {
						await next();
						await next();
					},
				},
			],
			render,
		});

		const response = await request("/");
		await response.text();

		expect(response.status).toBe(500);
		expect(render).toHaveBeenCalledTimes(1);
		expect(seen).toStrictEqual(["500 next() called multiple times"]);
		expect(summary(lines)).toStrictEqual([
			["unhandled error", "next() called multiple times"],
			["request", 500],
		]);
	});

	it("sends the response that a plugin sets after next(), in place of the answer of a later plugin", async () => {
		const { request, seen } = await pipeline({
			plugins: [
				{
					name: "replaces",
					middleware: async (context, next) => {
						await next();
						context.res = new Response("replaced", { status: 201 });
					},
				},
				{ name: "short", middleware: async (context) => context.text("short", 202) },
			],
		});

		const response = await request("/");

		expect([response.status, await response.text()]).toStrictEqual([201, "replaced"]);
		expect(seen).toStrictEqual(["201"]);
	});

	it("runs the setup of a plugin with no middleware, and passes each request on", async () => {
		const setup = vi.fn<NonNullable<Plugin["setup"]>>();
		const { request, seen } = await pipeline({ plugins: [{ name: "bare", setup }] });

		await expect((await request("/")).text()).resolves.toBe("rendered");
		expect(setup).toHaveBeenCalledTimes(1);
		expect(seen).toStrictEqual(["200"]);
	});

	it("runs the app's own middleware and route after the plugins", async () => {
		const { request, seen } = await pipeline({
			routes: (app) => {
				app.use("/hi", async (context, next) => {
					await next();
					context.header("X-App", "1");
				});
				app.get("/hi", (context) => context.text("hi"));
			},
		});

		const response = await request("/hi");

		expect([response.status, await response.text()]).toStrictEqual([200, "hi"]);
		expect(response.headers.get("X-App")).toBe("1");
		expect(seen).toStrictEqual(["200"]);
	});

	it("answers a route of a sub-app, and an error there with the sub-app's own onError", async () => {
		const api = new Hono();
		api.onError(async (error, context) => context.text(`api: ${error.message}`, 502));
		api.get("/ok", (context) => context.json({ ok: true }));
		api.get("/fails", () => {
			throw new Error("down");
		});
		const { request, lines, seen } = await pipeline({
			routes: (app) => {
				app.route("/api", api);
			},
		});

		const ok = await request("/api/ok");
		const failed = await request("/api/fails");

		expect([ok.status, await ok.json()]).toStrictEqual([200, { ok: true }]);
		expect([failed.status, await failed.text()]).toStrictEqual([502, "api: down"]);
		expect(seen).toStrictEqual(["200", "502 down"]);
		expect(summary(lines)).toStrictEqual([
			["request", 200],
			["request", 502],
		]);
	});

	it("runs a plugin after the static stage only for a request that the static stage passes on", async () => {
		const late: Plugin = {
			name: "late",
			middleware: async (context, next) => {
				await next();
				context.header("X-Late", "1");
			},
		};
		const { request } = await pipeline({ plugins: [prerenderedPlugin(), late], clientDirectory });

		expect((await request("/page")).headers.get("X-Late")).toBe("1");
		expect((await request("/about")).headers.get("X-Late")).toBeNull();
	});

	it.each([
		["no plugins", []],
		["a plugin", [requestId()]],
	])(
		"answers Hono's 404 for a path with no route before `prepare`, with %s",
		async (_, plugins) => {
			const app = createServer({ plugins, logger: { log: () => {} } });

			const response = await app.request("/missing");

			expect([response.status, await response.text()]).toStrictEqual([404, "404 Not Found"]);
		},
	);

	it("answers HEAD with the headers of GET and no body, for a rendered and a prerendered page", async () => {
		const { request, lines } = await testServer({ plugins: defaultPlugins(), clientDirectory });
		const headers = { "X-Request-Id": "abc-123" };

		for (const path of ["/page", "/about"]) {
			const get = await request(path, { headers });
			const head = await request(path, { method: "HEAD", headers });

			expect([head.status, [...head.headers]]).toStrictEqual([get.status, [...get.headers]]);
			await expect(head.text()).resolves.toBe("");
			await get.text();
		}
		expect(summary(lines)).toStrictEqual(Array.from({ length: 4 }, () => ["request", 200]));
	});

	it("gives the body of a POST to the framework through the default plugins", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins(),
			render: async (incoming) => new Response(await incoming.text()),
		});

		const response = await request("/page", { method: "POST", body: "hello" });

		await expect(response.text()).resolves.toBe("hello");
	});

	it("adds the etagPart of each plugin that a request passed to the ETag of a file, in order", async () => {
		const part = (value: string | undefined): Plugin => ({
			name: `part-${value}`,
			etagPart: () => value,
		});
		const passes: Plugin = {
			name: "passes",
			etagPart: () => "two",
			middleware: async (_context, next) => next(),
		};
		const etag = async (plugins: Plugin[]) =>
			(await (await testServer({ plugins, clientDirectory })).request("/about")).headers.get(
				"ETag",
			);

		const oneTwo = await etag([part("one"), part(undefined), passes, prerenderedPlugin()]);
		const one = await etag([part("one"), prerenderedPlugin()]);

		await expect(etag([part("one"), part("two"), prerenderedPlugin()])).resolves.toBe(oneTwo);
		await expect(etag([part("two"), part("one"), prerenderedPlugin()])).resolves.not.toBe(oneTwo);
		await expect(etag([part("one"), prerenderedPlugin(), part("two")])).resolves.toBe(one);
		await expect(etag([prerenderedPlugin()])).resolves.not.toBe(one);
	});

	const withEdge: { what: string; stages: Stages; answer: [number, string]; logged: unknown[] }[] =
		[
			{ what: "the framework", stages: {}, answer: [200, "rendered"], logged: [["request", 200]] },
			{
				what: "a plugin that answers",
				stages: {
					plugins: [{ name: "short", middleware: async (context) => context.text("short", 202) }],
				},
				answer: [202, "short"],
				logged: [["request", 202]],
			},
			{
				what: "a string that a plugin throws",
				stages:
					throwsAt["a plugin before next()"]?.(() => {
						// oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- the test throws a string on purpose.
						throw "boom";
					}) ?? {},
				answer: [500, "Internal Server Error"],
				logged: [
					["unhandled error", "A non-Error value was thrown: boom"],
					["request", 500],
				],
			},
			{
				what: "null that the framework throws",
				stages:
					throwsAt["the framework"]?.(() => {
						// oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- the test throws null on purpose.
						throw null;
					}) ?? {},
				answer: [500, "Internal Server Error"],
				logged: [
					["unhandled error", "A non-Error value was thrown: null"],
					["request", 500],
				],
			},
			{
				what: "an HTTPException that a route throws",
				stages:
					throwsAt["a route"]?.(() => {
						throw new HTTPException(418, { message: "teapot" });
					}) ?? {},
				answer: [418, "teapot"],
				logged: [["request", 418]],
			},
		];

	it.each(withEdge)(
		"gives a listener with an edge the answer and the head for $what",
		async ({ stages, answer, logged }) => {
			const { app, framework, lines } = await pipeline(stages);
			const edge = new ResponseEdge();

			const response = await app.fetch(
				new Request("http://localhost/", { headers: { "X-Request-Id": "abc-123" } }),
				{ framework, edge },
			);
			const head = edge.headersFor(response) ?? [];
			const text = await response.text();
			edge.close(response.status, false, head);

			expect([response.status, text]).toStrictEqual(answer);
			expect(head.slice(head.indexOf("x-request-id"))).toStrictEqual(["x-request-id", "abc-123"]);
			expect(summary(lines)).toStrictEqual(logged);
		},
	);

	it("answers each kind of request through the Node listener, with one access line for each", async () => {
		const lines: LoggedLine[] = [];
		const html = `<!doctype html><html><body>${"<p>hello</p>".repeat(400)}</body></html>`;
		const server = await listening(
			async (incoming) =>
				new Response(incoming.method === "POST" ? await incoming.text() : html, {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				}),
			defaultPlugins(),
			{
				trustForwardedProto: true,
				clientDirectory,
				logger: {
					log: (line) => {
						lines.push(line);
					},
				},
				routes: (app) => {
					app.get("/throws", () => {
						// oxlint-disable-next-line no-throw-literal, typescript/only-throw-error -- the test throws a string on purpose.
						throw "boom";
					});
				},
			},
		);
		/** The status, the body, and the headers that show which stage answered. */
		const answer = async (path: string, init: RequestInit = {}) => {
			const response = await fetch(new URL(path, server.urls[0]), { redirect: "manual", ...init });
			return [
				response.status,
				await response.text(),
				...["Content-Encoding", "Cache-Control", "Location", "Strict-Transport-Security"].map(
					(name) => response.headers.get(name),
				),
			];
		};
		const encoded = (encoding: string): RequestInit => ({
			headers: { "Accept-Encoding": encoding },
		});
		const privately = "private, no-cache";

		const answers = [
			await answer("/page", encoded("identity")),
			await answer("/page", encoded("br")),
			await answer("/page", encoded("gzip")),
			await answer("/page", { method: "HEAD", ...encoded("identity") }),
			await answer("/page", { method: "POST", body: "hello" }),
			await answer("/about", encoded("identity")),
			await answer("/about/", encoded("identity")),
			await answer("/assets/app-abc.js", encoded("br, gzip")),
			await answer("/assets/missing.js"),
			await answer("/livez"),
			await answer("/readyz"),
			await answer("/throws"),
			await answer("/page?x=1", { headers: { "X-Forwarded-Proto": "https" } }),
			await answer("/.env", encoded("identity")),
		];

		expect(answers).toStrictEqual([
			[200, html, null, privately, null, null],
			[200, html, "br", privately, null, null],
			[200, html, "gzip", privately, null, null],
			[200, "", null, privately, null, null],
			[200, "hello", null, privately, null, null],
			[200, about, null, "public, max-age=0, must-revalidate", null, null],
			[308, "", null, null, "/about", null],
			[200, script, "br", "public, max-age=31536000, immutable", null, null],
			[404, "Not Found", null, "no-store", null, null],
			[200, "ok", null, "no-store", null, null],
			[200, "ok", null, "no-store", null, null],
			[500, "Internal Server Error", null, null, null, null],
			[200, html, "gzip", privately, null, "max-age=31536000"],
			[200, html, null, privately, null, null],
		]);
		// Why a count: a line goes out when its response closes, which can be after the next request.
		const counts = () => {
			const count: Record<string, number> = {};
			for (const [message, detail] of summary(lines)) {
				const line = `${String(message)} ${String(detail)}`;
				count[line] = (count[line] ?? 0) + 1;
			}
			return count;
		};
		await expect.poll(counts).toStrictEqual({
			"listening undefined": 1,
			"request 200": 9,
			"request 308": 1,
			"request 404": 1,
			"request 500": 1,
			"unhandled error A non-Error value was thrown: boom": 1,
		});
		await server.shutdown();
	});
});
