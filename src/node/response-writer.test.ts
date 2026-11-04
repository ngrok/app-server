import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { constants, gunzipSync } from "node:zlib";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { defaultPlugins } from "../core/create-server.js";
import { eventStream } from "../core/event-stream.js";
import { withHeaderHook } from "../core/header-hook.js";
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
});
