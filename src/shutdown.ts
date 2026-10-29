// Why a global symbol: an app bundles its own copy of this package into the server build, and
// the CLI loads another copy. Both copies must see one shutdown signal.
const SHUTDOWN_KEY = Symbol.for("@ngrok/app-server/shutdown");

function shutdownController(): AbortController {
	const existing: unknown = Reflect.get(globalThis, SHUTDOWN_KEY);
	if (existing instanceof AbortController) {
		return existing;
	}
	const controller = new AbortController();
	Reflect.set(globalThis, SHUTDOWN_KEY, controller);
	return controller;
}

/**
 * A signal that aborts when the server starts to shut down. Read it for each
 * request: each start of a server makes a new one. A handler that
 * holds a response open, such as an event stream, stops on it so that the
 * drain does not wait for the deadline.
 *
 * @example
 * const timer = setInterval(sendUpdate, 1_000);
 * shutdownSignal().addEventListener("abort", () => clearInterval(timer), { once: true });
 */
export function shutdownSignal(): AbortSignal {
	return shutdownController().signal;
}

/** Replaces {@link shutdownSignal} with a new one that has not aborted. */
export function renewShutdownSignal(): void {
	Reflect.set(globalThis, SHUTDOWN_KEY, new AbortController());
}

/** Aborts {@link shutdownSignal}. */
export function abortShutdownSignal(): void {
	shutdownController().abort();
}
