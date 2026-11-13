import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
import { constants, gunzipSync } from "node:zlib";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { defaultPlugins } from "../core/create-server.js";
import type { AppServer } from "../core/create-server.js";
import { eventStream } from "../core/event-stream.js";
import { withHeaderHook } from "../core/header-hook.js";
import { accessLog } from "../core/plugins/access-log.js";
import { requestId } from "../core/plugins/request-id.js";
import { onResponseSent } from "../core/response-edge.js";
import { streamingCompress } from "../core/plugins/streaming-compress.js";
import type { FrameworkRuntime, Plugin } from "../core/types.js";
import { testServer } from "../test-server.js";
import { tcp } from "./tcp.js";

const encoder = new TextEncoder();
const page = `<main>${"<p>row</p>".repeat(300)}</main>`;

/** Serves `render` with `plugins` on the node host's TCP listener, and gives its URL. */
async function listening(
	render: FrameworkRuntime["fetch"],
	plugins: Plugin[] = defaultPlugins(),
): Promise<string> {
	const { internals, framework } = await testServer({
		plugins,
		render,
		options: { listeners: [tcp({ port: 0, host: "127.0.0.1" })] },
	});
	const server = await internals.listen(framework, []);
	onTestFinished(async () => server.shutdown());
	return server.urls[0] ?? "";
}

/** Serves like {@link listening}, with the app's `routes` and server options, and gives the log lines too. */
async function serving({
	render = async () => new Response(page, { headers: { "Content-Type": "text/html" } }),
	plugins = defaultPlugins(),
	routes,
	trustForwardedProto = false,
}: {
	render?: FrameworkRuntime["fetch"];
	plugins?: Plugin[];
	routes?: (app: AppServer) => void;
	trustForwardedProto?: boolean;
}) {
	const { internals, framework, lines } = await testServer({
		plugins,
		render,
		...(routes == null ? {} : { routes }),
		options: { listeners: [tcp({ port: 0, host: "127.0.0.1" })], trustForwardedProto },
	});
	const server = await internals.listen(framework, []);
	onTestFinished(async () => server.shutdown());
	const linesOf = (message: string) => lines.filter((line) => line.message === message);
	return { url: server.urls[0] ?? "", linesOf };
}

/** Sends a GET with `headers` and gives the response as it came on the wire. */
async function get(url: string, headers: Record<string, string> = {}): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		httpRequest(url, { headers }, resolve).once("error", reject).end();
	});
}

/** The bytes of the body of `response`, as they came on the wire. */
async function bodyOf(response: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of response) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

/** A plugin whose header hook throws. */
const throwsInHook: Plugin = {
	name: "throws-in-hook",
	middleware: async (context, next) =>
		withHeaderHook(context, next, () => {
			throw new Error("hook failed");
		}),
};

/** A plugin whose header hook sets `name` to `value`. */
function setsHeader(name: string, value: string): Plugin {
	return {
		name: `sets-${name}-${value}`,
		middleware: async (context, next) =>
			withHeaderHook(context, next, (headers) => {
				headers.set(name, value);
			}),
	};
}

describe("the node response writer", () => {
	it("sends a gzip page whose body has ended with its Content-Length", async () => {
		const url = await listening(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(page.slice(0, 1500)));
							controller.enqueue(encoder.encode(page.slice(1500)));
							controller.close();
						},
					}),
					{ headers: { "Content-Type": "text/html" } },
				),
		);

		const response = await get(url, { "Accept-Encoding": "gzip" });
		const body = await bodyOf(response);

		expect(response.headers["content-encoding"]).toBe("gzip");
		expect(response.headers["transfer-encoding"]).toBeUndefined();
		expect(response.headers["content-length"]).toBe(String(body.byteLength));
		expect(gunzipSync(body).toString()).toBe(page);
	});

	it("sends a response with no body with a Content-Length of 0, but not a HEAD response, a 204, or a 304", async () => {
		const url = await listening(
			async (request) =>
				new Response(null, { status: Number(new URL(request.url).pathname.slice(1)) }),
			[],
		);
		const framingOf = async (path: string, method = "GET") => {
			const response = await new Promise<IncomingMessage>((resolve, reject) => {
				httpRequest(new URL(path, url), { method }, resolve).once("error", reject).end();
			});
			await bodyOf(response);
			return [response.headers["content-length"], response.headers["transfer-encoding"]];
		};

		await expect(framingOf("/308")).resolves.toStrictEqual(["0", undefined]);
		await expect(framingOf("/200")).resolves.toStrictEqual(["0", undefined]);
		await expect(framingOf("/200", "HEAD")).resolves.toStrictEqual([undefined, undefined]);
		await expect(framingOf("/204")).resolves.toStrictEqual([undefined, undefined]);
		await expect(framingOf("/304")).resolves.toStrictEqual([undefined, undefined]);
	});

	it("sends the shell of a streamed page at once, with no timer, before the rest exists", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		let release: (() => void) | undefined;
		const url = await listening(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("<html>shell"));
							release = () => {
								controller.enqueue(encoder.encode("rest</html>"));
								controller.close();
							};
						},
					}),
					{ headers: { "Content-Type": "text/html" } },
				),
		);

		// Why no gzip: a CDN that compresses, as on Vercel, asks for the body as it is.
		const response = await get(url, { "Accept-Encoding": "identity" });
		const first = await new Promise<Buffer>((resolve) => {
			response.once("data", resolve);
		});
		release?.();

		expect(first.toString()).toBe("<html>shell");
		await expect(bodyOf(response).then(String)).resolves.toBe("rest</html>");
	});

	it("sends the head of an event stream through gzip before its first event", async () => {
		const opened = Promise.withResolvers<undefined>();
		const url = await listening(async () =>
			eventStream({}, async ({ send }) => {
				await opened.promise;
				send({ data: "hello" });
				return new Promise(() => {});
			}),
		);

		const response = await get(url, { "Accept-Encoding": "gzip" });
		opened.resolve(undefined);
		const first = await new Promise<Buffer>((resolve) => {
			response.once("data", resolve);
		});
		response.destroy();

		expect(response.headers["content-encoding"]).toBe("gzip");
		expect(gunzipSync(first, { finishFlush: constants.Z_SYNC_FLUSH }).toString()).toBe(
			"data: hello\n\n",
		);
	});

	it("sends each Set-Cookie on its own line", async () => {
		const url = await listening(async () => {
			const headers = new Headers({ "Content-Type": "text/plain" });
			headers.append("Set-Cookie", "a=1; Path=/");
			headers.append("Set-Cookie", "b=2; Path=/");
			return new Response("ok", { headers });
		});

		const response = await get(url);
		await bodyOf(response);

		expect(response.headers["set-cookie"]).toStrictEqual(["a=1; Path=/", "b=2; Path=/"]);
	});

	it("sends the headers of each header hook, and the outer stage has the last word", async () => {
		const url = await listening(
			async () => new Response("ok"),
			[setsHeader("X-Stage", "outer"), ...defaultPlugins(), setsHeader("X-Stage", "inner")],
		);

		const response = await get(url, { "Accept-Encoding": "gzip" });
		await bodyOf(response);

		expect(response.headers["x-stage"]).toBe("outer");
		expect(response.headers["x-request-id"]).toMatch(/^[\da-f-]{36}$/u);
		expect(response.headers["x-content-type-options"]).toBe("nosniff");
		expect(response.headers.vary).toBe("Accept-Encoding");
	});

	it("sends a page as it is when a later stage's header hook sets no-transform", async () => {
		const url = await listening(
			async () => new Response(page, { headers: { "Content-Type": "text/html" } }),
			[streamingCompress(), setsHeader("Cache-Control", "no-transform")],
		);

		const response = await get(url, { "Accept-Encoding": "gzip" });
		const body = await bodyOf(response);

		expect(response.headers["content-encoding"]).toBeUndefined();
		expect(response.headers["cache-control"]).toBe("no-transform");
		expect(body.toString()).toBe(page);
	});

	it("answers 500 when a header hook throws, and the outer hooks still run", async () => {
		const { url, linesOf } = await serving({
			plugins: [requestId(), accessLog(), throwsInHook],
		});

		const first = await fetch(url, { headers: { "X-Request-Id": "abc-123" } });
		const second = await fetch(url);

		expect([first.status, first.headers.get("X-Request-Id"), await first.text()]).toStrictEqual([
			500,
			"abc-123",
			"Internal Server Error",
		]);
		expect([second.status, await second.text()]).toStrictEqual([500, "Internal Server Error"]);
		await vi.waitFor(() => {
			expect(linesOf("request")).toHaveLength(2);
		});
		const attributes: Readonly<Record<string, unknown>> = linesOf("request")[0]?.attributes ?? {};
		expect([
			attributes["http.request_id"],
			attributes["http.status_code"],
			attributes["http.client_aborted"],
		]).toStrictEqual(["abc-123", 500, undefined]);
		expect(linesOf("unhandled error")[0]?.attributes).toMatchObject({
			"http.request_id": "abc-123",
			"error.message": "hook failed",
		});
	});

	it("answers 500 for a header value that Node.js cannot send", async () => {
		const { url, linesOf } = await serving({
			plugins: [accessLog(), setsHeader("X-Hooked", "a\nb")],
			routes: (app) => {
				app.get("/download", (c) =>
					c.body("file", 200, { "Content-Disposition": 'attachment; filename="a\u0001b.txt"' }),
				);
			},
		});

		const fromHook = await fetch(url);
		const fromRoute = await fetch(new URL("/download", url));

		expect([fromHook.status, await fromHook.text()]).toStrictEqual([500, "Internal Server Error"]);
		expect([fromRoute.status, await fromRoute.text()]).toStrictEqual([
			500,
			"Internal Server Error",
		]);
		await vi.waitFor(() => {
			expect(linesOf("request")).toHaveLength(2);
		});
		expect(linesOf("request").map((line) => line.attributes["http.status_code"])).toStrictEqual([
			500, 500,
		]);
		expect(linesOf("unhandled error")).toHaveLength(2);
	});

	it("answers 500 for a body that a plugin locked, and for a chunk that is not bytes", async () => {
		const locks: Plugin = {
			name: "locks",
			middleware: async (context, next) => {
				await next();
				if (context.req.path === "/locked") {
					context.res.body?.getReader();
				}
			},
		};
		const { url, linesOf } = await serving({
			plugins: [accessLog(), locks],
			render: async (request) =>
				new URL(request.url).pathname === "/locked"
					? new Response("locked")
					: new Response(
							new ReadableStream({
								start(controller) {
									controller.enqueue("hello");
									controller.close();
								},
							}),
						),
		});

		const locked = await fetch(new URL("/locked", url));
		const text = await fetch(new URL("/text", url));

		expect(locked.status).toBe(500);
		expect(text.status).toBe(500);
		await Promise.all([locked.text(), text.text()]);
		await vi.waitFor(() => {
			expect(linesOf("request")).toHaveLength(2);
		});
		expect(linesOf("request").map((line) => line.attributes["http.status_code"])).toStrictEqual([
			500, 500,
		]);
		expect(linesOf("unhandled error")).toHaveLength(2);
	});

	it("runs each report of a request", async () => {
		const statuses: number[] = [];
		const reports: Plugin = {
			name: "reports",
			middleware: async (context, next) => {
				await next();
				onResponseSent(context, ({ status }) => {
					statuses.push(status);
				});
			},
		};
		const { url, linesOf } = await serving({ plugins: [accessLog(), reports] });

		await (await fetch(url)).text();

		await vi.waitFor(() => {
			expect(linesOf("request")).toHaveLength(1);
			expect(statuses).toStrictEqual([200]);
		});
	});

	it("runs the hooks of a request that the app sends through itself with its bindings", async () => {
		let app: AppServer | undefined;
		const { url, linesOf } = await serving({
			plugins: defaultPlugins({
				contentSecurityPolicy: { policy: ({ scriptSrc }) => `script-src ${scriptSrc}` },
			}),
			render: async (_request, context) =>
				new Response(`<script nonce="${context.get("cspNonce") ?? ""}"></script>${page}`, {
					headers: { "Content-Type": "text/html" },
				}),
			routes: (routed) => {
				app = routed;
				routed.get("/old", async (c) =>
					routed.fetch(
						new Request(new URL("/new", c.req.url), { headers: c.req.raw.headers }),
						c.env,
					),
				);
			},
		});
		expect(app).toBeDefined();

		const response = await get(new URL("/old", url).href, { "Accept-Encoding": "gzip" });
		const raw = await bodyOf(response);
		const body = gunzipSync(raw).toString();
		const nonce = /nonce="(?<nonce>[^"]+)"/u.exec(body)?.groups?.nonce;

		expect(response.headers["content-encoding"]).toBe("gzip");
		expect(body).toContain("<main>");
		expect(response.headers["content-security-policy"]).toContain(`'nonce-${nonce ?? "none"}'`);
		await vi.waitFor(() => {
			expect(linesOf("request").map((line) => line.attributes["http.url"])).toStrictEqual([
				"/new",
				"/old",
			]);
		});
	});

	it("gives the app the target that the client sent, with the scheme of X-Forwarded-Proto", async () => {
		const seen: string[] = [];
		const { url } = await serving({
			trustForwardedProto: true,
			routes: (app) => {
				app.get("/form", (c) => {
					const { incoming } = c.env;
					seen.push(
						c.req.url,
						incoming instanceof Object && "url" in incoming ? String(incoming.url) : "",
					);
					return c.text("ok");
				});
			},
		});

		for (const host of ["app.example.com", "app.example.com:80"]) {
			// oxlint-disable-next-line no-await-in-loop -- the requests go one at a time, so `seen` keeps their order.
			await bodyOf(
				// oxlint-disable-next-line no-await-in-loop -- see above.
				await get(new URL("/form?q=1", url).href, { Host: host, "X-Forwarded-Proto": "https" }),
			);
		}

		expect(seen).toStrictEqual([
			"https://app.example.com/form?q=1",
			"/form?q=1",
			"https://app.example.com/form?q=1",
			"/form?q=1",
		]);
	});

	it("keeps the scheme of the socket without trustForwardedProto, and rejects a Host with a path", async () => {
		const seen: string[] = [];
		const routes = (app: AppServer) => {
			app.get("/*", (c) => {
				seen.push(c.req.url);
				return c.text("ok");
			});
		};
		const plain = await serving({ routes });
		const trusted = await serving({ routes, trustForwardedProto: true });

		await bodyOf(await get(new URL("/page", plain.url).href, { "X-Forwarded-Proto": "https" }));
		const odd = await get(new URL("/page", trusted.url).href, {
			Host: "example.com/admin?",
			"X-Forwarded-Proto": "https",
		});
		await bodyOf(odd);

		expect(seen).toStrictEqual([new URL("/page", plain.url).href]);
		expect(odd.statusCode).toBe(400);
	});

	it("answers an HTTP/1.0 request with no Host header, and a request with an empty Host, with the host localhost", async () => {
		const { url } = await serving({
			routes: (app) => {
				app.get("/url", (c) => c.text(c.req.url));
			},
		});
		const { port, hostname } = new URL(url);
		/** The status line and the body of the answer to the request `head`. Why a socket: `node:http` always sends `Host`. */
		const probe = async (head: string) =>
			new Promise<(string | undefined)[]>((resolve, reject) => {
				let answer = "";
				const socket = connect(Number(port), hostname, () => {
					socket.write(`${head}\r\n\r\n`);
				});
				socket.setEncoding("utf8");
				socket.on("data", (chunk: string) => {
					answer += chunk;
				});
				socket.once("error", reject);
				socket.once("end", () => {
					resolve([answer.split("\r\n")[0], answer.split("\r\n\r\n")[1]]);
				});
			});

		// An HTTP/1.0 health probe, as HAProxy sends by default.
		await expect(probe("GET /livez HTTP/1.0")).resolves.toStrictEqual(["HTTP/1.1 200 OK", "ok"]);
		await expect(probe("GET /url HTTP/1.0")).resolves.toStrictEqual([
			"HTTP/1.1 200 OK",
			"http://localhost/url",
		]);
		await expect(probe("GET /url HTTP/1.1\r\nHost:\r\nConnection: close")).resolves.toStrictEqual([
			"HTTP/1.1 200 OK",
			"http://localhost/url",
		]);
		// Why: Node.js answers an HTTP/1.1 request with no `Host` itself, before the listener.
		const [status] = await probe("GET /url HTTP/1.1\r\nConnection: close");
		expect(status).toBe("HTTP/1.1 400 Bad Request");
	});

	it("sends the headers of the header hooks with a HEAD response, and with a copy that a wrapper returns", async () => {
		const { url } = await serving({
			routes: (app) => {
				const dispatch = app.fetch;
				app.fetch = async (request, ...rest) => {
					const response = await dispatch(request, ...rest);
					if (new URL(request.url).pathname !== "/wrapped") {
						return response;
					}
					const copy = new Response(response.body, response);
					copy.headers.set("X-Wrapped", "yes");
					return copy;
				};
			},
		});
		const headersOf = async (path: string, method: string) => {
			const response = await fetch(new URL(path, url), { method });
			await response.text();
			return {
				id: response.headers.has("X-Request-Id"),
				nosniff: response.headers.get("X-Content-Type-Options"),
				cache: response.headers.get("Cache-Control"),
				wrapped: response.headers.get("X-Wrapped"),
			};
		};
		const hooked = { id: true, nosniff: "nosniff", cache: "private, no-cache" };

		await expect(headersOf("/page", "HEAD")).resolves.toStrictEqual({ ...hooked, wrapped: null });
		await expect(headersOf("/wrapped", "GET")).resolves.toStrictEqual({
			...hooked,
			wrapped: "yes",
		});
	});

	it("sends the headers that a wrapper of the app's fetch changes on the response that it returns", async () => {
		const { url } = await serving({
			routes: (app) => {
				const dispatch = app.fetch;
				app.fetch = async (request, ...rest) => {
					const response = await dispatch(request, ...rest);
					response.headers.set("Cache-Control", "no-store");
					response.headers.append("Set-Cookie", "session=1");
					return response;
				};
			},
		});

		const response = await fetch(url);
		await response.text();

		expect([
			response.headers.get("Cache-Control"),
			response.headers.getSetCookie(),
			response.headers.has("X-Request-Id"),
		]).toStrictEqual(["no-store", ["session=1"], true]);
	});

	it("logs no body bytes for the 500 of a HEAD request, because Node sends no body", async () => {
		const { url, linesOf } = await serving({
			plugins: [accessLog(), setsHeader("X-Hooked", "a\nb")],
		});

		const response = await fetch(url, { method: "HEAD" });

		expect(response.status).toBe(500);
		await vi.waitFor(() => {
			expect(linesOf("request")).toHaveLength(1);
		});
		expect(linesOf("request")[0]?.attributes).toMatchObject({
			"http.status_code": 500,
			"network.bytes_written": 0,
		});
	});

	it("logs a header hook that throws once on a page that it would gzip", async () => {
		const { url, linesOf } = await serving({
			plugins: [requestId(), accessLog(), streamingCompress(), throwsInHook],
		});

		const response = await get(url, { "Accept-Encoding": "gzip" });
		await bodyOf(response);

		expect(response.statusCode).toBe(500);
		await vi.waitFor(() => {
			expect(linesOf("request")).toHaveLength(1);
		});
		expect(linesOf("unhandled error")).toHaveLength(1);
	});
});
