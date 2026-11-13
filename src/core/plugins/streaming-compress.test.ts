import { randomBytes } from "node:crypto";
import { brotliDecompressSync, constants, gunzipSync } from "node:zlib";
import { Hono } from "hono";
import type { Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import { heldStream, productionSetup, stubFramework, testServer } from "../../test-server.js";
import { createServer, serverInternals } from "../create-server.js";
import { withHeaderHook } from "../header-hook.js";
import type { AppServerEnv, Plugin, ServerEnv } from "../types.js";
import { buildId } from "./build-id.js";
import { MAX_JOINED_BYTES, streamingCompress } from "./streaming-compress.js";

/** A plugin whose header hook sets `name` to `value`. */
function setsHeader(name: string, value: string): Plugin {
	return {
		name: `sets-${name.toLowerCase()}`,
		middleware: async (context, next) =>
			withHeaderHook(context, next, (headers) => {
				headers.set(name, value);
			}),
	};
}

describe("streamingCompress", () => {
	it("sends the first gzip chunk of a streamed page before the stream ends", async () => {
		const held = heldStream("<html>shell");
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () => held.response,
		});

		const response = await request("/streamed", { headers: { "Accept-Encoding": "gzip" } });
		const first = await response.body?.getReader().read();
		held.release();

		expect(response.headers.get("Content-Encoding")).toBe("gzip");
		expect(
			gunzipSync(first?.value ?? new Uint8Array(), {
				finishFlush: constants.Z_SYNC_FLUSH,
			}).toString(),
		).toBe("<html>shell");
	});

	it("sends brotli to a client that prefers it, and its first chunk before the stream ends", async () => {
		const held = heldStream("<html>shell");
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () => held.response,
		});

		const response = await request("/streamed", {
			headers: { "Accept-Encoding": "gzip, deflate, br" },
		});
		const reader = response.body?.getReader();
		const first = await reader?.read();
		held.release();

		expect(response.headers.get("Content-Encoding")).toBe("br");
		expect(
			brotliDecompressSync(first?.value ?? new Uint8Array(), {
				finishFlush: constants.BROTLI_OPERATION_FLUSH,
			}).toString(),
		).toBe("<html>shell");
	});

	it("sends the chunks that the source has queued as one gzip chunk, and a later chunk after them", async () => {
		const encoder = new TextEncoder();
		let source: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				source = controller;
				for (const part of ["<p>one</p>", "<p>two</p>", "<p>three</p>"]) {
					controller.enqueue(encoder.encode(part));
				}
			},
		});
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () => new Response(body, { headers: { "Content-Type": "text/html" } }),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });
		const reader = response.body?.getReader();
		const first = (await reader?.read())?.value ?? new Uint8Array();
		source?.enqueue(encoder.encode("<p>late</p>"));
		const second = (await reader?.read())?.value ?? new Uint8Array();
		source?.close();
		const text = (bytes: Uint8Array) =>
			gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH }).toString();

		expect(text(first)).toBe("<p>one</p><p>two</p><p>three</p>");
		expect(text(new Uint8Array([...first, ...second]))).toBe(
			"<p>one</p><p>two</p><p>three</p><p>late</p>",
		);
	});

	it("sends a page whose body has ended as one gzip chunk, with the gzip trailer", async () => {
		const page = `<main>${"<p>row</p>".repeat(300)}</main>`;
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (const part of [page.slice(0, 1500), page.slice(1500)]) {
								controller.enqueue(new TextEncoder().encode(part));
							}
							controller.close();
						},
					}),
					{ headers: { "Content-Type": "text/html" } },
				),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });
		const reader = response.body?.getReader();
		const first = (await reader?.read())?.value ?? new Uint8Array();
		const after = await reader?.read();

		expect(gunzipSync(first).toString()).toBe(page);
		expect(after?.done).toBe(true);
	});

	it("sends the gzip of a large chunk in pieces while zlib still compresses it", async () => {
		const chunk = randomBytes(256 * 1024);
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(chunk);
						},
					}),
					{ headers: { "Content-Type": "text/html" } },
				),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });
		const reader = response.body?.getReader();
		const first = (await reader?.read())?.value ?? new Uint8Array();
		await reader?.cancel();

		expect(first.byteLength).toBeGreaterThan(0);
		expect(first.byteLength).toBeLessThanOrEqual(constants.Z_DEFAULT_CHUNK);
	});

	it("drops a Content-Length and an Accept-Ranges that the gzip body would break", async () => {
		const page = `<p>${"hi ".repeat(500)}</p>`;
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () =>
				new Response(page, {
					headers: {
						"Content-Type": "text/html",
						"Content-Length": String(page.length),
						"Accept-Ranges": "bytes",
					},
				}),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });

		expect(response.headers.get("Content-Length")).toBeNull();
		expect(response.headers.get("Accept-Ranges")).toBeNull();
		expect(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe(page);
	});

	it("sends a body under 1 KiB as it is, because gzip would make it larger", async () => {
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () =>
				new Response('{"ok":true}', {
					headers: { "Content-Type": "application/json", "Content-Length": "11" },
				}),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });

		expect(response.headers.get("Content-Encoding")).toBeNull();
		expect(response.headers.get("Vary")).toBe("Accept-Encoding");
		await expect(response.text()).resolves.toBe('{"ok":true}');
	});

	it("sends a body from a string under 1 KiB as it is, with no Content-Length to read", async () => {
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () => new Response("hello", { headers: { "Content-Type": "text/plain" } }),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });

		expect(response.headers.get("Content-Encoding")).toBeNull();
		expect(response.headers.get("Vary")).toBe("Accept-Encoding");
		await expect(response.text()).resolves.toBe("hello");
	});

	it("adds Accept-Encoding to Vary once, and only on a type that it can gzip", async () => {
		const responses: Record<string, () => Response> = {
			"/image": () => new Response("png", { headers: { "Content-Type": "image/png" } }),
			"/varied": () =>
				new Response("text", {
					headers: { "Content-Type": "text/plain", Vary: "Accept, accept-encoding" },
				}),
		};
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async (incoming) => responses[new URL(incoming.url).pathname]?.() ?? new Response(),
		});

		const image = await request("/image");
		const varied = await request("/varied");

		expect(image.headers.get("Vary")).toBeNull();
		expect(varied.headers.get("Vary")).toBe("Accept, accept-encoding");
	});

	it("leaves an image, a no-transform response, and a client with no gzip alone", async () => {
		const responses: Record<string, () => Response> = {
			"/image": () => new Response("png", { headers: { "Content-Type": "image/png" } }),
			"/no-transform": () =>
				new Response("text", {
					headers: { "Content-Type": "text/plain", "Cache-Control": "no-transform" },
				}),
		};
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async (incoming) =>
				(
					responses[new URL(incoming.url).pathname] ??
					(() => new Response("text", { headers: { "Content-Type": "text/plain" } }))
				)(),
		});
		const gzip = { headers: { "Accept-Encoding": "gzip" } };

		const image = await request("/image", gzip);
		const noTransform = await request("/no-transform", gzip);
		const noGzip = await request("/text");

		expect(image.headers.get("Content-Encoding")).toBeNull();
		expect(noTransform.headers.get("Content-Encoding")).toBeNull();
		expect(noGzip.headers.get("Content-Encoding")).toBeNull();
		expect(noGzip.headers.get("Vary")).toBe("Accept-Encoding");
	});

	it("gzips each compressible type, such as an icon, a feed, and a font, but not a WOFF2 font", async () => {
		const types = [
			"image/x-icon",
			"application/rss+xml",
			"application/linkset+json",
			"font/ttf",
			"application/wasm",
			"application/x-sh",
			"font/woff2",
			"application/x-shockwave-flash",
		];
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async (incoming) =>
				new Response("a".repeat(2048), {
					headers: { "Content-Type": new URL(incoming.url).searchParams.get("type") ?? "" },
				}),
		});

		const encodings = await Promise.all(
			types.map(async (type) => {
				const response = await request(`/?type=${encodeURIComponent(type)}`, {
					headers: { "Accept-Encoding": "gzip" },
				});
				return [type, response.headers.get("Content-Encoding")];
			}),
		);

		expect(Object.fromEntries(encodings)).toStrictEqual({
			"image/x-icon": "gzip",
			"application/rss+xml": "gzip",
			"application/linkset+json": "gzip",
			"font/ttf": "gzip",
			"application/wasm": "gzip",
			"application/x-sh": "gzip",
			"font/woff2": null,
			"application/x-shockwave-flash": null,
		});
	});

	it("leaves a partial response alone, so its Content-Range still matches the bytes", async () => {
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () =>
				new Response("abc", {
					status: 206,
					headers: { "Content-Type": "text/plain", "Content-Range": "bytes 0-2/10" },
				}),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });

		expect(response.headers.get("Content-Encoding")).toBeNull();
		await expect(response.text()).resolves.toBe("abc");
	});

	it("sends a page as it is to a request with no Accept-Encoding", async () => {
		const page = `<p>${"hi ".repeat(500)}</p>`;
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () => new Response(page, { headers: { "Content-Type": "text/html" } }),
		});

		const response = await request("/");

		expect(response.headers.get("Content-Encoding")).toBeNull();
		expect(response.headers.get("Vary")).toBe("Accept-Encoding");
		await expect(response.text()).resolves.toBe(page);
	});

	it("follows the q values of Accept-Encoding, with q=0 as a refusal", async () => {
		const page = `<p>${"hi ".repeat(500)}</p>`;
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () => new Response(page, { headers: { "Content-Type": "text/html" } }),
		});
		const encodings: Record<string, string | null> = {
			"gzip;q=0, identity;q=1": null,
			"identity, gzip;q=0.5": null,
			"*;q=0": null,
			"*": "br",
			"gzip, br": "br",
			"br;q=0.5, gzip": "gzip",
			"br;q=0, *": "gzip",
		};

		for (const [header, encoding] of Object.entries(encodings)) {
			const response = await request("/", { headers: { "Accept-Encoding": header } });

			expect([header, response.headers.get("Content-Encoding")]).toStrictEqual([header, encoding]);
		}
	});

	it("joins queued chunks up to 64 KiB, and sends a chunk that does not fit after them", async () => {
		const sizes = [1024, 32 * 1024, 64 * 1024];
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const size of sizes) {
					controller.enqueue(new Uint8Array(size).fill(97));
				}
			},
		});
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () => new Response(body, { headers: { "Content-Type": "text/html" } }),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });
		const reader = response.body?.getReader();
		const first = (await reader?.read())?.value ?? new Uint8Array();
		const second = (await reader?.read())?.value ?? new Uint8Array();
		const inflate = (bytes: Uint8Array) =>
			gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH }).byteLength;

		expect(inflate(first)).toBe(1024 + 32 * 1024);
		expect(inflate(new Uint8Array([...first, ...second]))).toBe(1024 + 96 * 1024);
	});

	it("sends the shell before a run of empty chunks ends", async () => {
		const encoder = new TextEncoder();
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("<html>shell"));
			},
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array());
				if (pulls === 10_000) {
					controller.close();
				}
			},
		});
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () => new Response(body, { headers: { "Content-Type": "text/html" } }),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });
		const reader = response.body?.getReader();
		const first = (await reader?.read())?.value ?? new Uint8Array();
		await reader?.cancel();

		expect(gunzipSync(first, { finishFlush: constants.Z_SYNC_FLUSH }).toString()).toBe(
			"<html>shell",
		);
		expect(pulls).toBeLessThan(10);
	});

	it("reads the source at most 64 KiB ahead of the client", async () => {
		const chunk = new TextEncoder().encode("<p>chunk</p>");
		const total = 10_000;
		let pulls = 0;
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							pulls += 1;
							controller.enqueue(chunk);
							if (pulls === total) {
								controller.close();
							}
						},
					}),
					{ headers: { "Content-Type": "text/html" } },
				),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });
		const reader = response.body?.getReader();
		await reader?.read();
		await reader?.cancel();

		expect(pulls * chunk.byteLength).toBeLessThanOrEqual(MAX_JOINED_BYTES + 3 * chunk.byteLength);
	});

	it("keeps streaming past an empty chunk", async () => {
		const encoder = new TextEncoder();
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (const text of ["hello", "", "bye"]) {
								controller.enqueue(encoder.encode(text));
							}
							controller.close();
						},
					}),
					{ headers: { "Content-Type": "text/html" } },
				),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });

		expect(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe("hellobye");
	});

	it("drops a Content-Length that the header hook of a later stage sets on a gzip body", async () => {
		const page = `<p>${"hi ".repeat(500)}</p>`;
		const { request } = await testServer({
			plugins: [streamingCompress(), setsHeader("Content-Length", String(page.length))],
			render: async () => new Response(page, { headers: { "Content-Type": "text/html" } }),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });

		expect(response.headers.get("Content-Encoding")).toBe("gzip");
		expect(response.headers.get("Content-Length")).toBeNull();
		expect(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe(page);
	});

	it("leaves a body alone when the header hook of a later stage sets its encoding or range", async () => {
		const page = `<p>${"hi ".repeat(500)}</p>`;
		const bodyOf = async (name: string, value: string) => {
			const { request } = await testServer({
				plugins: [streamingCompress(), setsHeader(name, value)],
				render: async () => new Response(page, { headers: { "Content-Type": "text/html" } }),
			});
			const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });
			return [response.headers.get("Content-Encoding"), await response.text()];
		};

		await expect(bodyOf("Content-Encoding", "br")).resolves.toStrictEqual(["br", page]);
		await expect(bodyOf("Content-Range", "bytes 0-1502/2000")).resolves.toStrictEqual([null, page]);
	});

	it("compresses a body when a header hook throws before its stage has the value that the hook needs", async () => {
		// Why: the plugin runs each hook before the code that an earlier stage runs after its `next()`.
		const setsLate: Plugin = {
			name: "sets-late",
			middleware: async (context, next) => {
				const late: { value?: string } = {};
				await withHeaderHook(context, next, (headers) => {
					if (late.value == null) {
						throw new Error("The stage has no value yet.");
					}
					headers.set("X-Late", late.value);
				});
				late.value = "set";
			},
		};
		const page = `<p>${"hi ".repeat(500)}</p>`;
		const { request } = await testServer({
			plugins: [setsLate, streamingCompress()],
			render: async () => new Response(page, { headers: { "Content-Type": "text/html" } }),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });

		expect([
			response.status,
			response.headers.get("X-Late"),
			response.headers.get("Content-Encoding"),
		]).toStrictEqual([200, "set", "gzip"]);
		expect(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe(page);
	});

	it("leaves a body alone when a hook that a stage adds to headerHooks marks it no-transform", async () => {
		const page = `<p>${"hi ".repeat(500)}</p>`;
		const marks: Plugin = {
			name: "marks",
			middleware: async (context, next) => {
				// Why the annotation: the list is in the environment of the server, not of an app.
				const server: Context<ServerEnv> = context;
				server.get("headerHooks")?.push((headers) => {
					headers.set("Cache-Control", "public, no-transform");
				});
				await next();
			},
		};
		const { request } = await testServer({
			plugins: [marks, streamingCompress()],
			render: async () => new Response(page, { headers: { "Content-Type": "text/html" } }),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });

		expect(response.headers.get("Cache-Control")).toBe("public, no-transform");
		expect(response.headers.get("Content-Encoding")).toBeNull();
		await expect(response.text()).resolves.toBe(page);
	});

	it("calls the paths of buildId one time for a response that it compresses", async () => {
		const paths = vi.fn<(path: string) => boolean>(() => false);
		const { request } = await testServer({
			plugins: [buildId({ value: "b1", paths }), streamingCompress()],
			// Why not HTML: `buildId` asks `paths` only for a response that is not a document.
			render: async () =>
				new Response("hi ".repeat(500), { headers: { "Content-Type": "text/plain" } }),
		});

		const response = await request("/api/words", { headers: { "Accept-Encoding": "gzip" } });

		expect(response.headers.get("Content-Encoding")).toBe("gzip");
		expect(paths).toHaveBeenCalledTimes(1);
	});

	it("adds Accept-Encoding to Vary in a plain Hono app", async () => {
		const plugin = streamingCompress();
		await plugin.setup?.(await productionSetup({ logger: { log: () => {} } }));
		const app = new Hono<AppServerEnv>();
		if (plugin.middleware != null) {
			app.use(plugin.middleware);
		}
		app.get("/", (c) => c.html(`<p>${"hi ".repeat(500)}</p>`));

		const response = await app.request("/", { headers: { "Accept-Encoding": "gzip" } });

		expect(response.headers.get("Content-Encoding")).toBe("gzip");
		expect(response.headers.get("Vary")).toBe("Accept-Encoding");
	});

	it("gzips for a client that prefers brotli on a host with no brotli stream", async () => {
		const logger = { log: () => {} };
		const app = createServer({ plugins: [streamingCompress()], logger });
		// Why no `brotli` key: a host from before brotli builds its setup with no such key.
		const { brotli: _brotli, ...setup } = await productionSetup({ logger });
		await serverInternals(app)?.prepare(setup);

		const response = await app.request(
			"/",
			{ headers: { "Accept-Encoding": "br, gzip" } },
			{
				framework: stubFramework(
					async () => new Response("a".repeat(2048), { headers: { "Content-Type": "text/html" } }),
				),
			},
		);

		expect(response.headers.get("Content-Encoding")).toBe("gzip");
	});

	it("sends the response as it is on a host with no compression stream", async () => {
		const logger = { log: () => {} };
		const app = createServer({ plugins: [streamingCompress()], logger });
		await serverInternals(app)?.prepare({
			...(await productionSetup({ logger })),
			gzip: undefined,
			brotli: undefined,
		});

		const response = await app.request(
			"/",
			{ headers: { "Accept-Encoding": "br, gzip" } },
			{ framework: stubFramework() },
		);

		expect(response.headers.get("Content-Encoding")).toBeNull();
		await expect(response.text()).resolves.toBe("rendered");
	});
});
