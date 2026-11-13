import { shutdownSignal } from "./shutdown.js";

/** One server-sent event. */
export type ServerSentEvent = {
	data: string;
	event?: string;
	id?: string;
};

/** What {@link eventStream} passes to its producer. */
export type EventStreamSink = {
	send: (event: ServerSentEvent) => void;
	/**
	 * Aborts when the client disconnects or the server shuts down, while the stream is open. Stop
	 * the work on it.
	 */
	signal: AbortSignal;
};

/** Options for {@link eventStream}. */
export type EventStreamOptions = {
	/** The request's signal, so a client disconnect stops the stream. */
	signal?: AbortSignal;
	/**
	 * How often a `: ping` comment goes out, in milliseconds, so that a proxy keeps a quiet stream
	 * open. It must be an integer from 1 to 2,147,483,647, or `eventStream` throws a `RangeError`.
	 * @default 15000
	 */
	heartbeatMs?: number;
	/** Extra response headers. */
	headers?: HeadersInit;
};

/** Why: `setInterval` turns a longer delay, and a delay under 1, into 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

function formatEvent({ data, event, id }: ServerSentEvent): string {
	// Why: a line break in `event` or `id` would start another field or event.
	if (/[\r\n]/u.test(`${event ?? ""}${id ?? ""}`)) {
		throw new TypeError("An event's `event` and `id` cannot contain a line break.");
	}
	const lines = [
		...(event == null ? [] : [`event: ${event}`]),
		...(id == null ? [] : [`id: ${id}`]),
		// Why `\r` too: a client reads a lone carriage return as a line end.
		...data.split(/\r\n|\r|\n/u).map((line) => `data: ${line}`),
	];
	return `${lines.join("\n")}\n\n`;
}

/**
 * A `text/event-stream` response that stays correct for its whole life: it
 * sends a heartbeat comment, it stops when the client disconnects, and it
 * closes at server shutdown so the drain does not wait for the deadline. The
 * stream closes when `produce` resolves.
 *
 * @example
 * export async function loader({ request }: Route.LoaderArgs) {
 * 	return eventStream({ signal: request.signal }, async ({ send, signal }) => {
 * 		for await (const update of watchUpdates({ signal })) {
 * 			send({ event: "update", data: JSON.stringify(update) });
 * 		}
 * 	});
 * }
 */
export function eventStream(
	{ signal, heartbeatMs = 15_000, headers }: EventStreamOptions,
	produce: (sink: EventStreamSink) => void | Promise<void>,
): Response {
	if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > MAX_TIMER_MS) {
		throw new RangeError(
			`eventStream needs a heartbeatMs that is an integer from 1 to ${MAX_TIMER_MS}, not ${heartbeatMs}.`,
		);
	}
	const encoder = new TextEncoder();
	// Why `AbortSignal.any`: a listener of each open stream on `shutdownSignal()` makes that signal
	// walk a longer list each time a stream adds or removes its listener.
	const upstream = AbortSignal.any(
		signal == null ? [shutdownSignal()] : [shutdownSignal(), signal],
	);
	// Why not `upstream` for the producer: such a signal stays in memory while it has a listener and
	// a source lives, and `shutdownSignal()` lives until the server stops.
	const stopped = new AbortController();
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	/** The controller of the body, until the stream ends. */
	let open: ReadableStreamDefaultController<Uint8Array> | undefined;

	/** Ends the stream. It gives the controller to the first call only, to close or fail the body. */
	function end() {
		const controller = open;
		open = undefined;
		clearInterval(heartbeat);
		upstream.removeEventListener("abort", stop);
		return controller;
	}
	function close() {
		end()?.close();
	}
	function stop() {
		close();
		stopped.abort(upstream.reason);
	}
	function write(text: string) {
		open?.enqueue(encoder.encode(text));
	}

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			open = controller;
		},
		cancel() {
			end();
			stopped.abort();
		},
	});
	if (upstream.aborted) {
		close();
	} else {
		heartbeat = setInterval(() => {
			write(": ping\n\n");
		}, heartbeatMs);
		upstream.addEventListener("abort", stop);
		Promise.resolve()
			.then(async () =>
				produce({
					send: (event) => {
						write(formatEvent(event));
					},
					signal: stopped.signal,
				}),
			)
			.then(close, (error: unknown) => {
				end()?.error(error);
			});
	}

	const responseHeaders = new Headers(headers);
	responseHeaders.set("Content-Type", "text/event-stream; charset=utf-8");
	responseHeaders.set("Cache-Control", "no-cache");
	return new Response(body, { headers: responseHeaders });
}
