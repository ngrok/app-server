import { Agent, get } from "node:http";
import type { IncomingMessage } from "node:http";
import { buffer, text } from "node:stream/consumers";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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
	it("takes the ends of the idleTimeoutMs range", () => {
		expect(() => tcp({ idleTimeoutMs: 0 })).not.toThrow();
		expect(() => tcp({ idleTimeoutMs: 2_147_482_647 })).not.toThrow();
	});

	it.each([-1, 1.5, Number.NaN, 2_147_482_648, 2_147_483_647])(
		"refuses an idleTimeoutMs of %s with a message that names it",
		(idleTimeoutMs) => {
			expect(() => tcp({ idleTimeoutMs })).toThrow(
				`idleTimeoutMs must be an integer from 0 to 2147482647, not ${idleTimeoutMs}.`,
			);
		},
	);

	it("names HOST when it cannot listen on the host from the environment", async () => {
		// Why this address: it is in a range for documentation (TEST-NET-1), so no interface has it,
		// and the bind fails with no name lookup.
		vi.stubEnv("HOST", "192.0.2.1");

		const failure: unknown = await tcp({ port: 0 })
			.start(async () => new Response("ok"))
			.then(async (started) => started.stop({ deadlineMs: 0 }))
			.catch((error: unknown) => error);

		expect(failure).toMatchObject({
			message:
				'The server cannot listen on host "192.0.2.1", port 0. The host is from the HOST environment variable.',
			cause: { code: "EADDRNOTAVAIL" },
		});
	});

	it("keeps the error of the runtime for a port in use, with HOST set", async () => {
		vi.stubEnv("HOST", "127.0.0.1");
		const first = await tcp({ port: 0 }).start(async () => new Response("ok"));
		onTestFinished(async () => first.stop({ deadlineMs: 0 }));

		const failure: unknown = await tcp({ port: Number(new URL(first.url).port) })
			.start(async () => new Response("ok"))
			.then(async (started) => started.stop({ deadlineMs: 0 }))
			.catch((error: unknown) => error);

		expect(failure).toMatchObject({ code: "EADDRINUSE" });
	});

	it("keeps the error of the runtime for a host from the options", async () => {
		vi.stubEnv("HOST", "192.0.2.1");

		const failure: unknown = await tcp({ port: 0, host: "192.0.2.2" })
			.start(async () => new Response("ok"))
			.then(async (started) => started.stop({ deadlineMs: 0 }))
			.catch((error: unknown) => error);

		expect(failure).toMatchObject({ code: "EADDRNOTAVAIL" });
	});

	it("sets the largest idleTimeoutMs with no timer overflow in Node.js", async () => {
		// Why: Node.js adds 1 s to the value for the timer of each socket, and it warns when a
		// timer is over the limit.
		const warnings: string[] = [];
		const record = (warning: Error) => {
			warnings.push(warning.name);
		};
		process.on("warning", record);
		onTestFinished(() => {
			process.off("warning", record);
		});
		const started = await tcp({
			port: 0,
			host: "127.0.0.1",
			idleTimeoutMs: 2_147_482_647,
		}).start(async () => new Response("ok"));
		onTestFinished(async () => started.stop({ deadlineMs: 0 }));

		const response = await request(started.url);

		await expect(text(response)).resolves.toBe("ok");
		expect(response.headers["keep-alive"]).toBe("timeout=2147482");
		expect(warnings).not.toContain("TimeoutOverflowWarning");
	});

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
