import { asError } from "../log.js";
import { optionPlugin } from "../plugin-options.js";
import { isStopping } from "../shutdown.js";
import type { Plugin, RequestLogger } from "../types.js";

/** Options for {@link health}. */
export type HealthOptions = {
	/** @default "/livez" */
	livePath?: string;
	/** @default "/readyz" */
	readyPath?: string;
	/**
	 * An app check for readiness, such as a database ping. A `false` or a
	 * throw makes the server not ready. When the check starts to fail, one
	 * warn line goes to the log, and when it passes again, one info line.
	 */
	ready?: () => boolean | Promise<boolean>;
};

/** A probe answer that no cache keeps. */
function probe(text: string, status: 200 | 503): Response {
	return new Response(text, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
	});
}

/**
 * Answers the liveness and readiness probes of a load balancer or
 * Kubernetes. `livePath` always answers 200. `readyPath` answers 200 until
 * the server gets a stop signal, then 503. With `shutdownDelayMs` on
 * `createServer`, the listeners serve on for that time, so the load
 * balancer removes the server before the drain starts.
 *
 * `defaultPlugins()` runs it first, so a probe skips the access log. Its
 * `health` option takes these options, and `false` turns it off.
 *
 * @example
 * createServer({
 * 	plugins: defaultPlugins({ health: { ready: async () => db.ping() } }),
 * 	shutdownDelayMs: 5_000,
 * });
 */
export function health({
	livePath = "/livez",
	readyPath = "/readyz",
	ready,
}: HealthOptions = {}): Plugin {
	// Why log on a change only: a probe comes every few seconds.
	let appFailing = false;
	const appCheck = async (logger: RequestLogger): Promise<boolean> => {
		if (ready == null) {
			return true;
		}
		let passed = false;
		let failure: Record<string, unknown> = {};
		try {
			passed = await ready();
		} catch (error) {
			failure = { error: asError(error) };
		}
		if (!passed && !appFailing) {
			logger.warn("readiness check failed", failure);
		} else if (passed && appFailing) {
			logger.info("readiness check passed");
		}
		appFailing = !passed;
		return passed;
	};
	const isReady = async (logger: RequestLogger) => {
		if (isStopping()) {
			return false;
		}
		const appReady = await appCheck(logger);
		// Why check again: a stop signal can come while the app check runs.
		return appReady && !isStopping();
	};
	/** The answer to the probe at `path`, which is `livePath` or `readyPath`. */
	const answer = async (path: string, logger: RequestLogger) =>
		path === livePath || (await isReady(logger)) ? probe("ok", 200) : probe("not ready", 503);
	return optionPlugin("health", {
		name: "health",
		// oxlint-disable-next-line typescript/promise-function-async -- the server awaits each stage in a `try`, and an `async` stage adds a promise to each request.
		middleware: (context, next) => {
			const { method, path } = context.req;
			return (method === "GET" || method === "HEAD") && (path === livePath || path === readyPath)
				? answer(path, context.get("logger"))
				: next();
		},
	});
}
