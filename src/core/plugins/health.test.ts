import { describe, expect, it } from "vitest";
import { createServer, defaultPlugins, serverInternals } from "../create-server.js";
import { markStopping, renewShutdownSignal } from "../shutdown.js";
import { tcp } from "../../node/tcp.js";
import { productionSetup, stubFramework, testServer } from "../../test-server.js";
import type { LogSink } from "../types.js";
import { health } from "./health.js";

describe("health", () => {
	it("answers the probes with no-store and logs no line for them", async () => {
		const { request, lines } = await testServer({ plugins: [health(), ...defaultPlugins()] });

		const live = await request("/livez");
		const ready = await request("/readyz");

		expect([live.status, ready.status]).toStrictEqual([200, 200]);
		expect(live.headers.get("Cache-Control")).toBe("no-store");
		expect(lines).toStrictEqual([]);
	});

	it("is not ready when the app check fails or throws", async () => {
		const failing = await testServer({ plugins: [health({ ready: () => false })] });
		const throwing = await testServer({
			plugins: [
				health({
					ready: () => {
						throw new Error("The database is down.");
					},
				}),
			],
		});

		expect((await failing.request("/readyz")).status).toBe(503);
		expect((await throwing.request("/readyz")).status).toBe(503);
	});

	it("logs one line when the app check starts to fail, and one when it passes again", async () => {
		let up = false;
		const { request, lines } = await testServer({
			plugins: [
				health({
					ready: () => {
						if (!up) {
							throw new Error("The database is down.");
						}
						return true;
					},
				}),
			],
		});

		await request("/readyz");
		await request("/readyz");
		up = true;
		await request("/readyz");

		expect(
			lines.map((line) => [line.level, line.message, line.attributes["error.message"]]),
		).toStrictEqual([
			["warn", "readiness check failed", "The database is down."],
			["info", "readiness check passed", undefined],
		]);
	});

	it("is not ready when a stop signal comes while the app check runs", async () => {
		const { request } = await testServer({
			plugins: [
				health({
					ready: async () => {
						markStopping();
						return true;
					},
				}),
			],
		});

		try {
			expect((await request("/readyz")).status).toBe(503);
		} finally {
			renewShutdownSignal();
		}
	});

	it("fails readiness at the stop signal, and serves requests during the shutdown delay", async () => {
		const logger: LogSink = { log: () => {} };
		const app = createServer({
			plugins: [health()],
			logger,
			listeners: [tcp({ port: 0, host: "127.0.0.1" })],
			shutdownDelayMs: 500,
		});
		const internals = serverInternals(app);
		if (internals == null) {
			throw new Error("createServer returned an app with no internals.");
		}
		await internals.prepare(await productionSetup({ logger }));
		const server = await internals.listen(stubFramework(), []);
		const url = server.urls[0] ?? "";

		const stopped = server.shutdown();
		const ready = await fetch(new URL("/readyz", url));
		const page = await fetch(url);

		expect(ready.status).toBe(503);
		expect(page.status).toBe(200);
		await page.text();
		await ready.text();
		await stopped;
	});
});
