import { currentShutdown } from "./request-context.js";

/** The stop state of one app server. */
export type ShutdownState = {
	/** Aborts the {@link shutdownSignal} of the app server. */
	readonly controller: AbortController;
	/** Whether the app server got a stop signal. It is true during the shutdown delay, before the signal aborts. */
	stopping: boolean;
};

function newState(): ShutdownState {
	return { controller: new AbortController(), stopping: false };
}

/**
 * The state that the first `createServer` call takes. Why: a signal that a
 * module reads before that call then aborts when that server shuts down.
 */
let unclaimed: ShutdownState | undefined = newState();

/** The state of the last `createServer` call, which {@link shutdownSignal} reads outside a request. */
let latest = unclaimed;

/** The stop state of a new app server. Each `createServer` call takes one. */
export function createShutdownState(): ShutdownState {
	latest = unclaimed ?? newState();
	unclaimed = undefined;
	return latest;
}

/**
 * A signal that aborts when the server starts to shut down. A handler that
 * holds a response open, such as an event stream, stops on it so that the
 * drain does not wait for the deadline.
 *
 * In a request, and in work that the request started, it is the signal of the
 * app server that serves the request. Outside a request, and on a host with
 * no request storage, it is the signal of the last `createServer` call, as
 * the sink of `logger()` is.
 *
 * @example
 * const timer = setInterval(sendUpdate, 1_000);
 * shutdownSignal().addEventListener("abort", () => clearInterval(timer), { once: true });
 */
export function shutdownSignal(): AbortSignal {
	return (currentShutdown() ?? latest).controller.signal;
}

/** Aborts the {@link shutdownSignal} that a call outside a request gives. */
export function abortShutdownSignal(): void {
	latest.controller.abort();
}
