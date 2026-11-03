import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { basicAuth } from "hono/basic-auth";
import { z } from "zod";
import { createServer, defaultPlugins, serverInternals } from "./create-server.js";
import type { AppServer } from "./create-server.js";
import { eventStream } from "./event-stream.js";
import { renewShutdownSignal } from "./shutdown.js";
import { accessLog } from "./plugins/access-log.js";
import { buildId } from "./plugins/build-id.js";
import { health } from "./plugins/health.js";
import { noindex } from "./plugins/noindex.js";
import { runtimeEnv } from "./plugins/runtime-env.js";
import { tcp } from "../node/tcp.js";
import { productionSetup, renderedFramework, stubFramework, testServer } from "../test-server.js";
import type { FrameworkRuntime, Listener, LogSink, Plugin, StartedListener } from "./types.js";

/** Starts an app on a free local port with the default plugins. */
async function listening(
	render: FrameworkRuntime["fetch"],
	plugins: Plugin[] = defaultPlugins(),
	options: { trustForwardedProto?: boolean } = {},
) {
	const logger: LogSink = { log: () => {} };
	const app = createServer({
		...options,
		plugins,
		logger,
		listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		shutdownDeadlineMs: 2_000,
	});
	const internals = serverInternals(app);
	if (internals == null) {
		throw new Error("createServer returned an app with no internals.");
	}
	await internals.prepare(await productionSetup({ logger }));
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
				contentSecurityPolicy: { policy: (scriptSrc) => `script-src ${scriptSrc}` },
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
				contentSecurityPolicy: { policy: (scriptSrc) => `script-src ${scriptSrc}` },
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
