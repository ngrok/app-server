import { get as httpGet } from "node:http";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { tcp } from "../../node/tcp.js";
import { heldStream, productionSetup, stubFramework, testServer } from "../../test-server.js";
import { createServer, serverInternals } from "../create-server.js";
import { withHeaderHook } from "../header-hook.js";
import type { FrameworkRuntime, LogSink, Plugin } from "../types.js";
import { accessLog, loggedUrl } from "./access-log.js";
import { requestId } from "./request-id.js";
import { assets } from "./static.js";
import { streamingCompress } from "./streaming-compress.js";

const encoder = new TextEncoder();

/** A stage whose header hook sets `Cache-Control: no-store`. */
const noStore: Plugin = {
	name: "no-store",
	middleware: async (context, next) =>
		withHeaderHook(context, next, (headers) => {
			headers.set("Cache-Control", "no-store");
		}),
};

/** Serves `plugins` on a Node.js listener, as production does, and gives its URL and log lines. */
async function listening(plugins: Plugin[], render: FrameworkRuntime["fetch"]) {
	const { internals, framework, lines } = await testServer({
		plugins,
		render,
		options: { listeners: [tcp({ port: 0, host: "127.0.0.1" })] },
	});
	const server = await internals.listen(framework, []);
	onTestFinished(async () => server.shutdown());
	const requestLines = () => lines.filter((line) => line.message === "request");
	return { url: server.urls[0] ?? "", requestLines, lines };
}

/** Sends a GET that accepts gzip and gives the response as it came on the wire. */
async function getRaw(url: string): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		httpGet(url, { headers: { "Accept-Encoding": "gzip" } }, resolve).once("error", reject);
	});
}

/** The first chunk of `response`'s body. */
async function firstChunk(response: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve) => {
		response.once("data", resolve);
	});
}

describe("accessLog", () => {
	it("logs one line with the request ID and the query values redacted", async () => {
		const { request, lines } = await testServer({ plugins: [requestId(), accessLog()] });

		await (await request("/verify?code=123456", { headers: { "X-Request-Id": "abc-123" } })).text();

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			level: "info",
			message: "request",
			attributes: {
				"http.request_id": "abc-123",
				"http.method": "GET",
				"http.url": "/verify?code=REDACTED",
				"http.status_code": 200,
				"network.bytes_written": 8,
			},
		});
	});

	it("logs a streamed response when its body ends, with every byte counted", async () => {
		const held = heldStream("shell");
		const { request, lines } = await testServer({
			plugins: [accessLog()],
			render: async () => held.response,
		});

		const response = await request("/streamed");
		const reader = response.body?.getReader();
		await reader?.read();
		const linesBeforeEnd = lines.length;
		held.release();
		while ((await reader?.read())?.done === false) {
			// Drains the body.
		}

		expect(linesBeforeEnd).toBe(0);
		expect(lines[0]?.attributes["network.bytes_written"]).toBe(9);
	});

	it("marks a line when the client disconnects before the body ends", async () => {
		const held = heldStream("shell");
		const { request, lines } = await testServer({
			plugins: [accessLog()],
			render: async () => held.response,
		});

		const response = await request("/streamed");
		await response.body?.cancel();

		expect(lines[0]?.attributes["http.client_aborted"]).toBe(true);
	});

	it("logs a line when the response body fails", async () => {
		const { request, lines } = await testServer({
			plugins: [accessLog()],
			render: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							controller.error(new Error("render failed"));
						},
					}),
				),
		});

		const response = await request("/");
		await expect(response.text()).rejects.toThrow("render failed");

		expect(lines[0]?.attributes["http.client_aborted"]).toBe(true);
	});

	it("logs a HEAD request to an app route", async () => {
		const { request, lines } = await testServer({
			plugins: [accessLog()],
			routes: (app) => {
				app.get("/livez", (context) => context.text("ok"));
			},
		});

		await request("/livez", { method: "HEAD" });

		expect(lines[0]?.attributes["network.bytes_written"]).toBe(0);
	});

	it("adds the app's attributes to the line, and Server-Timing to a document when asked", async () => {
		const { request, lines } = await testServer({
			plugins: [accessLog({ attributes: () => ({ "usr.id": "user-1" }), serverTiming: true })],
		});

		const response = await request("/");
		await response.text();

		expect(lines[0]?.attributes).toMatchObject({ "usr.id": "user-1" });
		expect(response.headers.get("Server-Timing")).toMatch(/^app;dur=\d+\.\d$/u);
	});

	it("gives the attributes the headers that went out, with the changes of the header hooks", async () => {
		const { request, lines } = await testServer({
			plugins: [
				accessLog({
					attributes: ({ sent }) => ({
						"test.headers": [sent.headers.get("Cache-Control"), sent.headers.get("Content-Type")],
					}),
				}),
				noStore,
			],
		});

		await (await request("/")).text();
		await request("/", { method: "HEAD" });

		expect(lines.map((line) => line.attributes["test.headers"])).toStrictEqual([
			["no-store", "text/html; charset=utf-8"],
			["no-store", "text/html; charset=utf-8"],
		]);
	});

	it("keeps the response and logs one error line when the attributes callback throws", async () => {
		const { request, lines } = await testServer({
			plugins: [
				accessLog({
					attributes: () => {
						throw new Error("no user");
					},
				}),
			],
		});

		const head = await request("/", { method: "HEAD" });
		const get = await request("/");
		await get.text();

		expect([head.status, get.status]).toStrictEqual([200, 200]);
		expect(
			lines.map((line) => [line.level, line.message, line.attributes["error.message"]]),
		).toStrictEqual([
			["error", "access log attributes failed", "no user"],
			["error", "access log attributes failed", "no user"],
		]);
	});

	it("logs a 5xx at error, and a 4xx at info", async () => {
		const { request, lines } = await testServer({
			plugins: [accessLog()],
			render: async (rendered) =>
				new Response("x", { status: Number(new URL(rendered.url).pathname.slice(1)) }),
		});

		for (const status of [503, 500, 404, 200]) {
			await (await request(`/${status}`)).text();
		}

		expect(lines.map((line) => [line.attributes["http.status_code"], line.level])).toStrictEqual([
			[503, "error"],
			[500, "error"],
			[404, "info"],
			[200, "info"],
		]);
	});

	it("logs no line in development for a request that the dev server answers", async () => {
		const lines: string[] = [];
		const logger: LogSink = {
			log: ({ message, attributes }) => {
				lines.push(`${message} ${String(attributes["http.url"])}`);
			},
		};
		const app = createServer({ plugins: [accessLog(), assets()], logger });
		const framework = stubFramework();
		await serverInternals(app)?.prepare({
			...(await productionSetup({ logger })),
			mode: "development",
			devServer: async (context, next) =>
				context.req.path.startsWith("/@vite/") ? context.text("module") : next(),
			prerenderedPaths: [],
		});

		for (const path of ["/@vite/client", "/page"]) {
			await (await app.request(path, undefined, { framework })).text();
		}

		expect(lines).toStrictEqual(["request /page"]);
	});

	it("redacts the query of the Referer", async () => {
		const { request, lines } = await testServer({ plugins: [accessLog()] });

		await (
			await request("/", { headers: { Referer: "https://example.com/verify?code=123" } })
		).text();

		expect(lines[0]?.attributes["http.referer"]).toBe("https://example.com/verify?code=REDACTED");
	});

	it("puts the attributes of a request line in a fixed order", async () => {
		const held = heldStream("shell");
		const { request, lines } = await testServer({
			plugins: [
				requestId({ datadogTraceIds: true }),
				accessLog({ attributes: () => ({ "usr.id": "user-1" }) }),
			],
			render: async (rendered) =>
				new URL(rendered.url).pathname === "/held" ? held.response : new Response("ok"),
		});
		const headers = {
			"X-Request-Id": "abc-123",
			traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			"User-Agent": "agent",
			Referer: "https://example.com/a",
		};

		await (await request("/page?code=1", { headers })).text();
		await (await request("/held", { headers })).body?.cancel();

		const keys = [
			"http.request_id",
			"http.method",
			"http.url_details.path",
			"trace_id",
			"span_id",
			"dd.trace_id",
			"dd.span_id",
			"http.url",
			"http.status_code",
			"http.useragent",
			"http.referer",
			"network.client.ip",
			"network.bytes_written",
			"duration",
		];
		expect(lines.map((line) => Object.keys(line.attributes))).toStrictEqual([
			[...keys, "usr.id"],
			[...keys, "http.client_aborted", "usr.id"],
		]);
	});
});

describe("accessLog on the Node.js listener", () => {
	it("counts the gzip bytes that the client got, when the response ends", async () => {
		const page = `<p>${"streamed ".repeat(400)}</p>`;
		const { url, requestLines } = await listening(
			[accessLog(), streamingCompress()],
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (const part of [page.slice(0, 1000), page.slice(1000)]) {
								controller.enqueue(new TextEncoder().encode(part));
							}
							controller.close();
						},
					}),
					{ headers: { "Content-Type": "text/html" } },
				),
		);

		const response = await getRaw(new URL("/streamed", url).href);
		let received = 0;
		for await (const chunk of response) {
			received += (chunk as Buffer).byteLength;
		}
		await vi.waitFor(() => {
			expect(requestLines()).toHaveLength(1);
		});

		expect(response.headers["content-encoding"]).toBe("gzip");
		expect(requestLines()[0]?.attributes["network.bytes_written"]).toBe(received);
		expect(requestLines()[0]?.attributes["http.client_aborted"]).toBeUndefined();
	});

	it("marks the line when the client disconnects before the body ends", async () => {
		const held = heldStream("shell");
		const { url, requestLines } = await listening([accessLog()], async () => held.response);

		const response = await getRaw(new URL("/streamed", url).href);
		const first = await firstChunk(response);
		response.destroy();
		await vi.waitFor(() => {
			expect(requestLines()).toHaveLength(1);
		});

		expect(first.toString()).toBe("shell");
		expect(requestLines()[0]?.attributes).toMatchObject({
			"http.status_code": 200,
			"network.bytes_written": 5,
			"http.client_aborted": true,
		});
	});

	it("logs a 5xx as 499 at info when the client went away before the app answered", async () => {
		let arrived = () => {};
		const started = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		const { url, requestLines } = await listening([accessLog()], async (request) => {
			arrived();
			await new Promise((resolve) => {
				request.signal.addEventListener("abort", resolve, { once: true });
			});
			// Why: React Router answers a request whose signal aborted with a 500.
			return new Response("Unexpected Server Error", { status: 500 });
		});

		const client = httpGet(new URL("/login", url).href).once("error", () => {});
		await started;
		client.destroy();
		await vi.waitFor(() => {
			expect(requestLines()).toHaveLength(1);
		});

		expect(requestLines()[0]).toMatchObject({
			level: "info",
			attributes: { "http.status_code": 499, "http.client_aborted": true },
		});
	});

	it("logs a 5xx at error when its body fails and the client stays", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		onTestFinished(() => {
			vi.restoreAllMocks();
		});
		let source: ReadableStreamDefaultController<Uint8Array> | undefined;
		const { url, requestLines } = await listening(
			[accessLog()],
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							source = controller;
							controller.enqueue(encoder.encode("first"));
						},
					}),
					{ status: 503, headers: { "Content-Type": "text/plain" } },
				),
		);

		const response = await getRaw(new URL("/fails", url).href);
		response.once("error", () => {});
		await firstChunk(response);
		source?.error(new Error("render failed"));
		await vi.waitFor(() => {
			expect(requestLines()).toHaveLength(1);
		});

		expect(requestLines()[0]).toMatchObject({
			level: "error",
			attributes: { "http.status_code": 503, "http.client_aborted": true },
		});
	});

	it("counts only the bytes that went out before a body fails, and marks the line", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		onTestFinished(() => {
			vi.restoreAllMocks();
		});
		let source: ReadableStreamDefaultController<Uint8Array> | undefined;
		const { url, requestLines } = await listening(
			[accessLog()],
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							source = controller;
							controller.enqueue(encoder.encode("first"));
						},
					}),
					{ headers: { "Content-Type": "text/plain" } },
				),
		);

		const response = await getRaw(new URL("/fails", url).href);
		const first = await firstChunk(response);
		source?.error(new Error("render failed"));
		await vi.waitFor(() => {
			expect(requestLines()).toHaveLength(1);
		});

		expect(first.toString()).toBe("first");
		expect(requestLines()[0]?.attributes).toMatchObject({
			"network.bytes_written": 5,
			"http.client_aborted": true,
		});
	});

	it("answers 500 and logs it when a queued body does not match its Content-Length", async () => {
		const { url, requestLines, lines } = await listening([accessLog()], async (request) => {
			const body = new URL(request.url).pathname === "/short" ? "short" : "longer than ten";
			return new Response(body, {
				headers: { "Content-Type": "image/png", "Content-Length": "10" },
			});
		});

		const short = await fetch(new URL("/short", url));
		const long = await fetch(new URL("/long", url));

		expect([short.status, await short.text()]).toStrictEqual([500, "Internal Server Error"]);
		expect([long.status, await long.text()]).toStrictEqual([500, "Internal Server Error"]);
		await vi.waitFor(() => {
			expect(requestLines()).toHaveLength(2);
		});
		expect(requestLines().map((line) => line.attributes)).toMatchObject([
			{ "http.status_code": 500, "network.bytes_written": 21 },
			{ "http.status_code": 500, "network.bytes_written": 21 },
		]);
		expect(lines.filter((line) => line.message === "unhandled error")).toHaveLength(2);
	});

	it("closes the connection and marks the line when a streamed body ends before its Content-Length", async () => {
		let sendRest = () => {};
		const { url, requestLines } = await listening([accessLog()], async () => {
			let pulls = 0;
			const body = new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						pulls += 1;
						if (pulls > 1) {
							controller.close();
							return;
						}
						// Why wait: the head goes out before the body ends short.
						await new Promise<void>((resolve) => {
							sendRest = resolve;
						});
						controller.enqueue(encoder.encode("short"));
					},
				},
				{ highWaterMark: 0 },
			);
			return new Response(body, {
				headers: { "Content-Type": "image/png", "Content-Length": "10" },
			});
		});

		const response = await getRaw(new URL("/image.png", url).href);
		sendRest();
		const ended = await new Promise<boolean>((resolve) => {
			response.on("data", () => {});
			response.once("end", () => {
				resolve(true);
			});
			response.once("error", () => {
				resolve(false);
			});
		});
		await vi.waitFor(() => {
			expect(requestLines()).toHaveLength(1);
		});

		expect(ended).toBe(false);
		expect(requestLines()[0]?.attributes).toMatchObject({
			"http.status_code": 200,
			"network.bytes_written": 5,
			"http.client_aborted": true,
		});
	});

	it("marks the line when the client leaves before Node.js sends the last bytes", async () => {
		const size = 16 * 1024 * 1024;
		const { url, requestLines } = await listening(
			[accessLog()],
			async () => new Response(new Uint8Array(size), { headers: { "Content-Type": "text/plain" } }),
		);

		const response = await getRaw(new URL("/large", url).href);
		await firstChunk(response);
		response.destroy();
		await vi.waitFor(() => {
			expect(requestLines()).toHaveLength(1);
		});

		expect(requestLines()[0]?.attributes).toMatchObject({
			"network.bytes_written": size,
			"http.client_aborted": true,
		});
	});

	it("answers 500 and logs it when a body fails before the head goes out", async () => {
		const { url, requestLines, lines } = await listening(
			[requestId(), accessLog()],
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("shell"));
						},
						pull(controller) {
							controller.error(new Error("render failed"));
						},
					}),
					{ headers: { "Content-Type": "text/plain" } },
				),
		);

		const response = await fetch(new URL("/fails-early", url), {
			headers: { "X-Request-Id": "abc-123" },
		});

		expect([response.status, await response.text()]).toStrictEqual([500, "Internal Server Error"]);
		await vi.waitFor(() => {
			expect(requestLines()).toHaveLength(1);
		});
		expect(requestLines()[0]?.attributes).toMatchObject({
			"http.status_code": 500,
			"network.bytes_written": 21,
		});
		expect(lines.find((line) => line.message === "unhandled error")?.attributes).toMatchObject({
			"http.request_id": "abc-123",
			"error.message": "render failed",
		});
	});

	it("gives the attributes the head that went out, also for HEAD and for the 500 of the listener", async () => {
		const { url, requestLines } = await listening(
			[
				accessLog({
					attributes: ({ sent }) => ({
						"test.headers": ["Cache-Control", "Content-Type", "Content-Length"].map((name) =>
							sent.headers.get(name),
						),
					}),
				}),
				noStore,
			],
			async (request) =>
				new URL(request.url).pathname === "/fails"
					? new Response(
							new ReadableStream<Uint8Array>({
								pull(controller) {
									controller.error(new Error("render failed"));
								},
							}),
						)
					: new Response("rendered"),
		);

		await (await fetch(new URL("/page", url))).text();
		await fetch(new URL("/page", url), { method: "HEAD" });
		await (await fetch(new URL("/fails", url))).text();
		await vi.waitFor(() => {
			expect(requestLines()).toHaveLength(3);
		});

		expect(requestLines().map((line) => line.attributes["test.headers"])).toStrictEqual([
			["no-store", "text/plain;charset=UTF-8", "8"],
			["no-store", "text/plain;charset=UTF-8", null],
			[null, "text/plain; charset=UTF-8", "21"],
		]);
	});

	it("logs the response that an earlier plugin sends in place of the logged one", async () => {
		const replacer: Plugin = {
			name: "replacer",
			middleware: async (context, next) => {
				await next();
				context.res = new Response("replaced", { status: 503 });
			},
		};
		const { url, requestLines } = await listening(
			[replacer, accessLog()],
			async () => new Response("rendered"),
		);

		const response = await fetch(new URL("/page", url));
		await response.text();
		await vi.waitFor(() => {
			expect(requestLines()).toHaveLength(1);
		});

		expect(requestLines()[0]?.attributes).toMatchObject({
			"http.status_code": 503,
			"network.bytes_written": 8,
		});
	});

	it("keeps each response, and stops a body that no one reads, when the log sink throws", async () => {
		const logger: LogSink = {
			log: ({ message }) => {
				if (message === "request" || message === "access log attributes failed") {
					throw new Error("the sink is closed");
				}
			},
		};
		const cancelled = vi.fn<() => void>();
		const render = async (request: Request) =>
			new URL(request.url).pathname === "/held"
				? new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(encoder.encode("shell"));
							},
							cancel: cancelled,
						}),
					)
				: new Response("rendered");
		const app = createServer({
			plugins: [accessLog()],
			logger,
			listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		});
		const internals = serverInternals(app);
		await internals?.prepare(await productionSetup({ logger }));
		const server = await internals?.listen(stubFramework(render), []);
		onTestFinished(async () => server?.shutdown());
		const url = server?.urls[0] ?? "";

		const first = await fetch(new URL("/page", url));
		await first.text();
		const head = await fetch(new URL("/page", url), { method: "HEAD" });
		const aborted = await getRaw(new URL("/held", url).href);
		await firstChunk(aborted);
		aborted.destroy();
		await vi.waitFor(() => {
			expect(cancelled).toHaveBeenCalledTimes(1);
		});
		const second = await fetch(new URL("/page", url));

		expect(head.status).toBe(200);
		await expect(second.text()).resolves.toBe("rendered");
	});

	it("logs the path and query that a URL parse gives, for targets that a parse changes", async () => {
		// Why these targets: the line takes the path of a URL with no query and no fragment as it is,
		// so the listener must give each of these as a parsed URL.
		const logged = {
			"/a/../b": "/b",
			'/a"b': "/a%22b",
			"/a{b}": "/a%7Bb%7D",
			"/%2e%2e/x": "/x",
			"/a#frag": "/a",
			"/a?": "/a",
			"/a?x='y'#f": "/a?x=%27y%27",
		};
		const { url, requestLines } = await listening(
			[accessLog({ redactQuery: false })],
			async () => new Response("ok"),
		);
		const { port } = new URL(url);

		for (const path of Object.keys(logged)) {
			const response = await new Promise<IncomingMessage>((resolve, reject) => {
				httpGet({ host: "127.0.0.1", port, path }, resolve).once("error", reject);
			});
			response.resume();
			await new Promise((resolve) => {
				response.once("end", resolve);
			});
		}
		await vi.waitFor(() => {
			expect(requestLines()).toHaveLength(Object.keys(logged).length);
		});

		expect(requestLines().map((line) => line.attributes["http.url"])).toStrictEqual(
			Object.values(logged),
		);
	});
});

describe("loggedUrl", () => {
	it("keeps the query as is when redaction is off", () => {
		expect(loggedUrl(new URL("https://example.com/a?b=1"), { redact: false })).toBe("/a?b=1");
	});

	it("keeps the path and the query keys when redaction is on", () => {
		expect(loggedUrl(new URL("https://example.com/a?b=1&c=2"), { redact: true })).toBe(
			"/a?b=REDACTED&c=REDACTED",
		);
		expect(loggedUrl(new URL("https://example.com/a"), { redact: true })).toBe("/a");
	});
});
