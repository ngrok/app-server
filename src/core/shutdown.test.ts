import { describe, expect, it } from "vitest";
import { createServer, serverInternals } from "./create-server.js";
import { shutdownSignal } from "./shutdown.js";
import { productionSetup, stubFramework } from "../test-server.js";
import type { LogSink } from "./types.js";

// Why at module load: no test of this file made a server yet, as when a route module of an app
// reads the signal before `server.ts` calls `createServer`.
const early = shutdownSignal();

/** Starts an app server with a listener that takes no connection. */
async function listening() {
	const logger: LogSink = { log: () => {} };
	const app = createServer({
		plugins: [],
		logger,
		listeners: [{ start: async () => ({ url: "http://localhost:1/", stop: async () => {} }) }],
	});
	const internals = serverInternals(app);
	if (internals == null) {
		throw new Error("createServer returned an app with no internals.");
	}
	await internals.prepare(await productionSetup({ logger }));
	return internals.listen(stubFramework(), []);
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
});
