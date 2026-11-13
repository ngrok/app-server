import { Agent, get } from "node:http";
import type { IncomingMessage } from "node:http";
import { buffer, text } from "node:stream/consumers";
import { describe, expect, it, onTestFinished } from "vitest";
import { heldStream } from "../test-server.js";
import { listenerUrl } from "./runtimes/listen-options.js";
import { parsePort, tcp } from "./tcp.js";

/** The drain deadline of the tests that stop a listener with an open request. */
const DEADLINE_MS = 2_000;

/** Sends a GET on a keep-alive connection, and gives the response when its head comes. */
async function request(url: string): Promise<IncomingMessage> {
	const agent = new Agent({ keepAlive: true });
	onTestFinished(() => {
		agent.destroy();
	});
	return new Promise((resolve, reject) => {
		get(url, { agent }, resolve).once("error", reject);
	});
}

describe("parsePort", () => {
	it("reads the ends of the port range", () => {
		expect(parsePort("0")).toBe(0);
		expect(parsePort("65535")).toBe(65_535);
	});

	it.each(["65536", "-1", "3.5", "http", ""])(
		"refuses %j with a message that names it",
		(value) => {
			expect(() => parsePort(value)).toThrow(
				`PORT must be an integer from 0 to 65535, not "${value}".`,
			);
		},
	);
});

describe("listenerUrl", () => {
	it("reads a wildcard bind as localhost", () => {
		expect(listenerUrl(undefined, 3000)).toBe("http://localhost:3000/");
		expect(listenerUrl("0.0.0.0", 3000)).toBe("http://localhost:3000/");
		expect(listenerUrl("::", 3000)).toBe("http://localhost:3000/");
	});

	it("brackets an IPv6 address", () => {
		expect(listenerUrl("::1", 3000)).toBe("http://[::1]:3000/");
		expect(listenerUrl("127.0.0.1", 3000)).toBe("http://127.0.0.1:3000/");
	});
});

describe("tcp", () => {
	it.each([-1, 1.5, Number.NaN, 2_147_483_647])(
		"refuses an idleTimeoutMs of %s with a message that names it",
		(idleTimeoutMs) => {
			expect(() => tcp({ idleTimeoutMs })).toThrow(
				`idleTimeoutMs must be an integer from 0 to 2147482647, not ${idleTimeoutMs}.`,
			);
		},
	);

	it("keeps an idle connection for longer than the request timeout of Node.js", async () => {
		const started = await tcp({ port: 0, host: "127.0.0.1", idleTimeoutMs: 620_000 }).start(
			async () => new Response("ok"),
		);
		onTestFinished(async () => started.stop({ deadlineMs: 0 }));

		const response = await request(started.url);
		response.resume();

		expect(response.statusCode).toBe(200);
		expect(response.headers["keep-alive"]).toBe("timeout=620");
	});

	it("ends the drain with the response of a request in flight, which says Connection: close", async () => {
		const entered = Promise.withResolvers<undefined>();
		const answer = Promise.withResolvers<Response>();
		const started = await tcp({ port: 0, host: "127.0.0.1" }).start(async () => {
			entered.resolve(undefined);
			return answer.promise;
		});
		const response = request(started.url);
		await entered.promise;

		const begin = performance.now();
		const stopped = started.stop({ deadlineMs: DEADLINE_MS });
		answer.resolve(new Response("ok"));
		await stopped;

		expect(performance.now() - begin).toBeLessThan(DEADLINE_MS / 2);
		expect((await response).headers.connection).toBe("close");
		await expect(text(await response)).resolves.toBe("ok");
	});

	it("ends the drain with a response that was open when the drain began", async () => {
		const { response: held, release } = heldStream("first,");
		const started = await tcp({ port: 0, host: "127.0.0.1" }).start(async () => held);
		const response = await request(started.url);
		await new Promise((resolve) => {
			response.once("readable", resolve);
		});

		const begin = performance.now();
		const stopped = started.stop({ deadlineMs: DEADLINE_MS });
		release();
		await stopped;

		expect(performance.now() - begin).toBeLessThan(DEADLINE_MS / 2);
		await expect(text(response)).resolves.toBe("first,rest");
	});

	it("sends a large body whole when the drain begins while its bytes still go out", async () => {
		// Why 32 MiB: the socket buffers of the client and the server hold less, so the rest waits in Node.
		const body = new Uint8Array(32 * 1024 * 1024);
		const started = await tcp({ port: 0, host: "127.0.0.1" }).start(async () => new Response(body));
		// Why no read yet: the client then takes no more bytes than its buffers hold.
		const response = await request(started.url);

		const stopped = started.stop({ deadlineMs: 30_000 });
		const received = await buffer(response);
		await stopped;

		expect(received.byteLength).toBe(body.byteLength);
	});
});
