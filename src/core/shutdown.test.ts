import { describe, expect, it, onTestFinished } from "vitest";
import { createServer, serverInternals } from "./create-server.js";
import { shutdownSignal } from "./shutdown.js";
import { host } from "../node/index.js";
import { tcp } from "../node/tcp.js";
import { productionSetup, stubFramework } from "../test-server.js";
import type { FrameworkRuntime, Listener, LogSink } from "./types.js";

// Why at module load: no test of this file made a server yet, as when a route module of an app
// reads the signal before `server.ts` calls `createServer`.
const early = shutdownSignal();

/** A listener that takes no connection. */
const idle: Listener = {
	start: async () => ({ url: "http://localhost:1/", stop: async () => {} }),
};

/** Starts an app server with the request storage of the node host. */
async function listening(listener: Listener = idle, render?: FrameworkRuntime["fetch"]) {
	const logger: LogSink = { log: () => {} };
	const app = createServer({
		plugins: [],
		logger,
		listeners: [listener],
		shutdownDeadlineMs: 2_000,
	});
	const internals = serverInternals(app);
	if (internals == null) {
		throw new Error("createServer returned an app with no internals.");
	}
	internals.setRequestStore(host.storage);
	await internals.prepare(await productionSetup({ logger }));
	return internals.listen(stubFramework(render), []);
}

describe("shutdownSignal", () => {
	it("aborts a signal that a module read before the first createServer call, when that server shuts down", async () => {
		const server = await listening();
		const before = early.aborted;

		await server.shutdown();

		expect([before, early.aborted]).toStrictEqual([false, true]);
	});

	it("gives the signal of the last createServer call outside a request", async () => {
		const first = await listening();
		const second = await listening();
		const signal = shutdownSignal();

		await first.shutdown();
		const afterFirst = signal.aborted;
		await second.shutdown();

		expect([afterFirst, signal.aborted]).toStrictEqual([false, true]);
	});

	it("gives work of a request the signal of its app server, also after the response and a later createServer call", async () => {
		const responseEnded = Promise.withResolvers<undefined>();
		let during: AbortSignal | undefined;
		let late: Promise<AbortSignal> | undefined;
		const first = await listening(tcp({ port: 0, host: "127.0.0.1" }), async () => {
			during = shutdownSignal();
			// Why work that the request starts: it runs in the request storage, as a timer does.
			late = (async () => {
				await responseEnded.promise;
				return shutdownSignal();
			})();
			return new Response("rendered");
		});
		const second = await listening();
		onTestFinished(second.shutdown);

		await (await fetch(first.urls[0] ?? "")).text();
		const outside = shutdownSignal();
		// Why a shutdown first: it waits until the listener wrote the response and closed its connection.
		await first.shutdown();
		responseEnded.resolve(undefined);
		const after = await late;

		expect(after).toBe(during);
		expect([during?.aborted, outside.aborted]).toStrictEqual([true, false]);
	});
});
