import { describe, expect, it, vi } from "vitest";
import { testServer } from "../../test-server.js";
import { bodyLimit } from "./body-limit.js";

/** A framework that reads the whole request body and echoes its length. */
async function readBody(request: Request): Promise<Response> {
	const body = await request.arrayBuffer();
	return new Response(String(body.byteLength));
}

/** A request body that streams `chunks` chunks of 10 bytes, with no `Content-Length`. */
function streamedBody(chunks: number): RequestInit {
	let sent = 0;
	const init: RequestInit & { duplex: "half" } = {
		method: "POST",
		duplex: "half",
		body: new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent === chunks) {
					controller.close();
					return;
				}
				sent += 1;
				controller.enqueue(new Uint8Array(10));
			},
		}),
	};
	return init;
}

describe("bodyLimit", () => {
	it("answers a body that is too large by its Content-Length with a 413, and never runs the app", async () => {
		let rendered = false;
		const { request } = await testServer({
			plugins: [bodyLimit({ maxBytes: 10 })],
			render: async () => {
				rendered = true;
				return new Response("ok");
			},
		});

		const response = await request("/upload", {
			method: "POST",
			headers: { "Content-Length": "11" },
			body: "x".repeat(11),
		});

		expect(response.status).toBe(413);
		expect(rendered).toBe(false);
	});

	it("lets a body up to the limit through", async () => {
		const { request } = await testServer({
			plugins: [bodyLimit({ maxBytes: 10 })],
			render: readBody,
		});

		const response = await request("/upload", { method: "POST", body: "x".repeat(10) });

		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("10");
	});

	it("answers a streamed body with no Content-Length that passes the limit with a 413", async () => {
		const { request } = await testServer({
			plugins: [bodyLimit({ maxBytes: 25 })],
			render: readBody,
		});

		const small = await request("/upload", streamedBody(2));
		const large = await request("/upload", streamedBody(3));

		await expect(small.text()).resolves.toBe("20");
		expect(large.status).toBe(413);
		await expect(large.text()).resolves.toBe("Payload Too Large");
	});

	it("errors the response stream when the app streams a body that passes the limit into its response", async () => {
		const { request } = await testServer({
			plugins: [bodyLimit({ maxBytes: 25 })],
			render: async (incoming) => new Response(incoming.body),
		});

		const response = await request("/upload", streamedBody(3));

		expect(response.status).toBe(200);
		await expect(response.text()).rejects.toThrow(
			"The request body is larger than the body limit.",
		);
	});

	it("cancels the request body when the app cancels it before the first read", async () => {
		const cancel = vi.fn<(reason: unknown) => void>();
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			duplex: "half",
			body: new ReadableStream<Uint8Array>({ cancel }),
		};
		const { request } = await testServer({
			plugins: [bodyLimit({ maxBytes: 10 })],
			render: async (incoming) => {
				await incoming.body?.cancel("not needed");
				return new Response("ok");
			},
		});

		await request("/upload", init);

		expect(cancel).toHaveBeenCalledExactlyOnceWith("not needed");
	});

	it("stops startup for a maxBytes that is not a whole number of 0 or more", () => {
		for (const maxBytes of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
			expect(() => bodyLimit({ maxBytes })).toThrow("bodyLimit needs a maxBytes");
		}
		expect(() => bodyLimit({ maxBytes: 0 })).not.toThrow();
	});
});
