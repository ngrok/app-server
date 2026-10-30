import { isStopping } from "../shutdown.js";
import type { Plugin } from "../types.js";

/** Options for {@link health}. */
export type HealthOptions = {
	/** @default "/livez" */
	livePath?: string;
	/** @default "/readyz" */
	readyPath?: string;
	/** An app check for readiness, such as a database ping. A `false` or a throw makes the server not ready. */
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
 * Put it first, so a probe skips the access log. It is not in
 * `defaultPlugins()`, because an app can have its own route at `/livez`.
 *
 * @example
 * createServer({ plugins: [health(), ...defaultPlugins()], shutdownDelayMs: 5_000 });
 */
export function health({
	livePath = "/livez",
	readyPath = "/readyz",
	ready,
}: HealthOptions = {}): Plugin {
	const isReady = async () => {
		if (isStopping()) {
			return false;
		}
		try {
			const appReady = (await ready?.()) ?? true;
			// Why check again: a stop signal can come while the app check runs.
			return appReady && !isStopping();
		} catch {
			return false;
		}
	};
	return {
		name: "health",
		middleware: async (context, next) => {
			const { method, path } = context.req;
			if (method !== "GET" && method !== "HEAD") {
				return next();
			}
			if (path === livePath) {
				return probe("ok", 200);
			}
			if (path === readyPath) {
				return (await isReady()) ? probe("ok", 200) : probe("not ready", 503);
			}
			return next();
		},
	};
}
