import { constants, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { heldStream, testServer } from "../test-server.js";
import { streamingCompress } from "./streaming-compress.js";

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

	it("drops a Content-Length that the gzip body would break", async () => {
		const { request } = await testServer({
			plugins: [streamingCompress()],
			render: async () =>
				new Response("<p>hi</p>", {
					headers: { "Content-Type": "text/html", "Content-Length": "9" },
				}),
		});

		const response = await request("/", { headers: { "Accept-Encoding": "gzip" } });

		expect(response.headers.get("Content-Length")).toBeNull();
		expect(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe("<p>hi</p>");
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
});
