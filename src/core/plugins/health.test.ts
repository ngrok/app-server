import { describe, expect, it } from "vitest";
import { createServer, defaultPlugins, serverInternals } from "../create-server.js";
import { tcp } from "../../node/tcp.js";
import { productionSetup, stubFramework, testServer } from "../../test-server.js";
import type { FetchHandler, LogSink } from "../types.js";
import { health } from "./health.js";

describe("health", () => {
	it("answers the probes with no-store and logs no line for them", async () => {
		const { request, lines } = await testServer({ plugins: defaultPlugins() });

		const live = await request("/livez");
		const ready = await request("/readyz");

		expect([live.status, ready.status]).toStrictEqual([200, 200]);
		expect(live.headers.get("Cache-Control")).toBe("no-store");
		expect(lines).toStrictEqual([]);
	});

	it("answers the probes at livePath and readyPath, and not at the default paths", async () => {
		const { request } = await testServer({
			plugins: [health({ livePath: "/up", readyPath: "/ready", ready: () => false })],
		});

		expect((await request("/up")).status).toBe(200);
		expect((await request("/ready")).status).toBe(503);
		await expect((await request("/livez")).text()).resolves.toBe("rendered");
		await expect((await request("/readyz")).text()).resolves.toBe("rendered");
	});

	it("stops startup for a path that does not start with a slash", () => {
		expect(() => health({ livePath: "livez" })).toThrow(
			'health needs a livePath that starts with "/", not "livez".',
		);
		expect(() => health({ readyPath: "" })).toThrow(
			'health needs a readyPath that starts with "/", not "".',
		);
	});

	it("stops startup for a path with a query or a fragment, which no request path has", () => {
		expect(() => health({ readyPath: "/readyz?full" })).toThrow(
			'health needs a readyPath with no "?" and no "#", not "/readyz?full".',
		);
		expect(() => health({ livePath: "/livez#a" })).toThrow(
			'health needs a livePath with no "?" and no "#", not "/livez#a".',
		);
	});

	it("stops startup for one path for both probes, which would never run the readiness check", () => {
		expect(() => health({ livePath: "/healthz", readyPath: "/healthz" })).toThrow(
			'health needs a livePath and a readyPath that differ. Both are "/healthz"',
		);
		expect(() => health({ readyPath: "/livez" })).toThrow(
			"For one health URL, set only readyPath.",
		);
		expect(() => defaultPlugins({ health: { livePath: "/readyz" } })).toThrow("differ");
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

	it("answers a HEAD probe, and hands a POST to a probe path to the next stage", async () => {
		// Why a failing check: the 503 of the probe is not the 200 of the framework.
		const { request } = await testServer({ plugins: [health({ ready: () => false })] });

		const live = await request("/livez", { method: "HEAD" });
		const ready = await request("/readyz", { method: "HEAD" });
		const posted = await Promise.all(
			["/livez", "/readyz"].map(async (path) => (await request(path, { method: "POST" })).text()),
		);

		expect([live.status, live.headers.get("Cache-Control")]).toStrictEqual([200, "no-store"]);
		expect(ready.status).toBe(503);
		expect(posted).toStrictEqual(["rendered", "rendered"]);
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
		const logger: LogSink = { log: () => {} };
		let fetch: FetchHandler | undefined;
		/** The server, after it listens. */
		const running: { shutdown?: (() => Promise<void>) | undefined } = {};
		let stopped: Promise<void> | undefined;
		const app = createServer({
			plugins: [
				health({
					ready: () => {
						stopped = running.shutdown?.();
						return true;
					},
				}),
			],
			logger,
			listeners: [
				{
					start: async (handler) => {
						fetch = handler;
						return { url: "http://localhost:1/", stop: async () => {} };
					},
				},
			],
		});
		const internals = serverInternals(app);
		await internals?.prepare(await productionSetup({ logger }));
		running.shutdown = (await internals?.listen(stubFramework(), []))?.shutdown;

		const ready = await fetch?.(new Request("http://localhost/readyz"));

		expect(ready?.status).toBe(503);
		await stopped;
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
