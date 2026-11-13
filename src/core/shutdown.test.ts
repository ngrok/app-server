import type { MiddlewareHandler } from "hono";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createServer, serverInternals } from "./create-server.js";
import { createEntry } from "./entry.js";
import { assets } from "./plugins/static.js";
import { shutdownSignal } from "./shutdown.js";
import { servedApps } from "../cli/served-apps.js";
import { host } from "../node/index.js";
import { tcp } from "../node/tcp.js";
import { productionSetup, stubFramework } from "../test-server.js";
import type { AppServerEnv, FrameworkRuntime, Listener, LogSink } from "./types.js";

const logger: LogSink = { log: () => {} };

/** A listener that takes no connection. */
const idle: Listener = {
	start: async () => ({ url: "http://localhost:1/", stop: async () => {} }),
};

/**
 * Starts an app server with the request storage of the node host. `core` is
 * the copy of the server module that makes it.
 */
async function listening({
	listener = idle,
	render,
	core = { createServer, serverInternals },
}: {
	listener?: Listener;
	render?: FrameworkRuntime["fetch"];
	core?: { createServer: typeof createServer; serverInternals: typeof serverInternals };
} = {}) {
	const app = core.createServer({
		plugins: [],
		logger,
		listeners: [listener],
		shutdownDeadlineMs: 2_000,
	});
	const internals = core.serverInternals(app);
	if (internals == null) {
		throw new Error("createServer returned an app with no internals.");
	}
	internals.setRequestStore(host.storage);
	await internals.prepare(await productionSetup({ logger }));
	return internals.listen(stubFramework(render), []);
}

/** The dev server of `app-server start`, with no module to serve. */
const devServer: MiddlewareHandler<AppServerEnv> = async (_context, next) => next();

/** Sends one request of `app-server start` to a new app server, and gives the signal that the request read. */
async function signalInDevelopment(
	apps: ReturnType<typeof servedApps>,
): Promise<AbortSignal | undefined> {
	let signal: AbortSignal | undefined;
	const app = createServer({ plugins: [assets()], logger });
	app.get("/", (context) => {
		signal = shutdownSignal();
		return context.text("answered");
	});
	const entry = createEntry({ app, host, framework: () => stubFramework() });
	await apps.serve(entry, async ({ fetchDev }) =>
		fetchDev(new Request("http://localhost/"), {}, devServer),
	);
	return signal;
}

describe("shutdownSignal", () => {
	it("aborts a signal that a module read before the first createServer call, when that server shuts down", async () => {
		// Why a new copy of the modules: only the first `createServer` call of a copy takes the state
		// of an earlier read, as when a route module reads the signal before `server.ts` runs.
		vi.resetModules();
		const early = (await import("./shutdown.js")).shutdownSignal();
		const server = await listening({ core: await import("./create-server.js") });
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
		const first = await listening({
			listener: tcp({ port: 0, host: "127.0.0.1" }),
			render: async () => {
				during = shutdownSignal();
				// Why work that the request starts: it runs in the request storage, as a timer does.
				late = (async () => {
					await responseEnded.promise;
					return shutdownSignal();
				})();
				return new Response("rendered");
			},
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

	// Why: an edit to `server.ts` makes a new app server, and the CLI lets go of the app server
	// before it. A route module that the edit did not load again keeps the signal that it read.
	it("aborts the signal of each app server at the exit of app-server start, also of one that an edit replaced", async () => {
		const apps = servedApps();
		const replaced = await signalInDevelopment(apps);
		const signals = [replaced, shutdownSignal(), await signalInDevelopment(apps)];
		const beforeExit = signals.map((signal) => signal?.aborted);

		await apps.stopAll();

		expect(signals[2]).not.toBe(replaced);
		expect(beforeExit).toStrictEqual([false, false, false]);
		expect(signals.map((signal) => signal?.aborted)).toStrictEqual([true, true, true]);
	});
});
