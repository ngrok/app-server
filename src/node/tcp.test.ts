import { get } from "node:http";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, onTestFinished } from "vitest";
import { listenerUrl } from "./runtimes/listen-options.js";
import { parsePort, tcp } from "./tcp.js";

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

		const response = await new Promise<IncomingMessage>((resolve, reject) => {
			get(started.url, resolve).once("error", reject);
		});
		response.resume();

		expect(response.statusCode).toBe(200);
		expect(response.headers["keep-alive"]).toBe("timeout=620");
	});
});
