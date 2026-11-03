import { constants, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { heldStream, productionSetup, stubFramework, testServer } from "../../test-server.js";
import { createServer, serverInternals } from "../create-server.js";
import { MAX_JOINED_BYTES, streamingCompress } from "./streaming-compress.js";

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
			"*": "gzip",
			"br, gzip;q=0.1": "gzip",
		};

		for (const [header, encoding] of Object.entries(encodings)) {
			const response = await request("/", { headers: { "Accept-Encoding": header } });

			expect([header, response.headers.get("Content-Encoding")]).toStrictEqual([header, encoding]);
		}
	});

	it("reads the source at most 16 KiB ahead of the client", async () => {
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

	it("sends the response as it is on a host with no gzip stream", async () => {
		const logger = { log: () => {} };
		const app = createServer({ plugins: [streamingCompress()], logger });
		await serverInternals(app)?.prepare({
			...(await productionSetup({ logger })),
			gzip: undefined,
		});

		const response = await app.request(
			"/",
			{ headers: { "Accept-Encoding": "gzip" } },
			{ framework: stubFramework() },
		);

		expect(response.headers.get("Content-Encoding")).toBeNull();
		await expect(response.text()).resolves.toBe("rendered");
	});
});
