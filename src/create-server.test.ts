import { request as httpRequest } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { basicAuth } from "hono/basic-auth";
import { createServer, defaultPlugins, serverInternals } from "./create-server.js";
import type { AppServer } from "./create-server.js";
import { eventStream } from "./event-stream.js";
import { accessLog } from "./plugins/access-log.js";
import { tcp } from "./tcp.js";
import { renderedFramework, testServer } from "./test-server.js";
import type { FrameworkAdapter, Listener, LogSink, Plugin, StartedListener } from "./types.js";

/** Starts an app on a free local port with the default plugins. */
async function listening(render: FrameworkAdapter["fetch"], plugins: Plugin[] = defaultPlugins()) {
	const logger: LogSink = { log: () => {} };
	const app = createServer({
		plugins,
		logger,
		listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		shutdownDeadlineMs: 2_000,
	});
	const internals = serverInternals(app);
	if (internals == null) {
		throw new Error("createServer returned an app with no internals.");
	}
	const framework: FrameworkAdapter = {
		clientDirectory: "/nonexistent",
		prerenderedPaths: [],
		fetch: render,
	};
	await internals.prepare({
		mode: "production",
		clientDirectory: "/nonexistent",
		prerenderedPaths: [],
		logger,
	});
	return internals.listen(framework);
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

	it("logs an unhandled error and answers 500", async () => {
		const { request, lines } = await testServer({
			plugins: [],
			render: async () => {
				throw new TypeError("boom");
			},
		});

		const response = await request("/");

		expect(response.status).toBe(500);
		expect(lines).toStrictEqual([
			{
				level: "error",
				message: "unhandled error",
				attributes: expect.objectContaining({ "error.kind": "TypeError", "error.message": "boom" }),
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
					level: "info",
					message: "request",
					attributes: expect.objectContaining({ "http.status_code": 500 }),
				},
			]);
		},
	);

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

		await expect(
			serverInternals(app)?.listen({
				clientDirectory: "/nonexistent",
				prerenderedPaths: [],
				fetch: renderedFramework,
			}),
		).rejects.toThrow("address in use");
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
		const server = await internals?.listen({
			clientDirectory: "/nonexistent",
			prerenderedPaths: [],
			fetch: renderedFramework,
		});

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
});
