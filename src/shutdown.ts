let controller = new AbortController();

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
	return controller.signal;
}

/** Replaces {@link shutdownSignal} with a new one that has not aborted. */
export function renewShutdownSignal(): void {
	controller = new AbortController();
}

/** Aborts {@link shutdownSignal}. */
export function abortShutdownSignal(): void {
	controller.abort();
}
