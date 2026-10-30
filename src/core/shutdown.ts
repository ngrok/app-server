let controller = new AbortController();
let stopping = false;

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

/** Replaces {@link shutdownSignal} with a new one that has not aborted, and clears {@link isStopping}. */
export function renewShutdownSignal(): void {
	controller = new AbortController();
	stopping = false;
}

/** Marks the server as stopping, before the shutdown delay and the drain. */
export function markStopping(): void {
	stopping = true;
}

/** Whether the server got a stop signal. It is true during the shutdown delay, before {@link shutdownSignal} aborts. */
export function isStopping(): boolean {
	return stopping;
}

/** Aborts {@link shutdownSignal}. */
export function abortShutdownSignal(): void {
	controller.abort();
}
