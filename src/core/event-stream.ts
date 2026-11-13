import { shutdownSignal } from "./shutdown.js";

/** One server-sent event. */
export type ServerSentEvent = {
	data: string;
	event?: string;
	id?: string;
};

/** What {@link eventStream} passes to its producer. */
export type EventStreamSink = {
	/** Sends `event` at once. It does not wait for the client. */
	send: (event: ServerSentEvent) => void;
	/**
	 * Aborts while the stream is open: when the client disconnects, when the server shuts down, or
	 * when more than 1 MiB of events wait for the client. Stop the work on it.
	 */
	signal: AbortSignal;
};

/** Options for {@link eventStream}. */
export type EventStreamOptions = {
	/** The request's signal, so a client disconnect stops the stream. */
	signal?: AbortSignal;
	/**
	 * How often a `: ping` comment goes out, in milliseconds, so that a proxy keeps a quiet stream
	 * open. It must be from 1 to 2,147,483,647, or `eventStream` throws a `RangeError`.
	 * @default 15000
	 */
	heartbeatMs?: number;
	/** Extra response headers. */
	headers?: HeadersInit;
};

/** Why: `setInterval` turns a longer delay, and a delay under 1, into 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The most bytes of events that wait for a client. Why 1 MiB: a burst of 1,000 events of 1 KiB
 * fits, and a client that does not read cannot fill the memory.
 */
const MAX_QUEUED_BYTES = 1024 * 1024;

/** Why one object: a stream reads its strategy and does not keep it. */
const QUEUE_STRATEGY = new ByteLengthQueuingStrategy({ highWaterMark: MAX_QUEUED_BYTES });

/** The line of the field `name` of an event, or no text when the event does not have the field. */
function fieldLine(name: string, value: string | undefined): string {
	if (value == null) {
		return "";
	}
	// Why: a line break in `event` or `id` would start another field or event.
	if (/[\r\n]/u.test(value)) {
		throw new TypeError("An event's `event` and `id` cannot contain a line break.");
	}
	return `${name}: ${value}\n`;
}

function formatEvent({ data, event, id }: ServerSentEvent): string {
	// Why: a value can have another type than its type says, such as the result of
	// `JSON.stringify(undefined)`. An array has `includes` too, and its line breaks would go out as
	// they are.
	if (typeof data !== "string") {
		throw new TypeError(`An event's \`data\` must be a string, not ${typeof data}.`);
	}
	// Why `includes`: most events have one line, and a replace that finds no line break costs more.
	const hasLineBreak = data.includes("\n") || data.includes("\r");
	// Why `\r` too: a client reads a lone carriage return as a line end.
	const lines = hasLineBreak ? data.replaceAll(/\r\n|\r|\n/gu, "\ndata: ") : data;
	return `${fieldLine("event", event)}${fieldLine("id", id)}data: ${lines}\n\n`;
}

/**
 * A `text/event-stream` response that stays correct for its whole life: it
 * sends a heartbeat comment, it stops when the client disconnects, and it
 * closes at server shutdown so the drain does not wait for the deadline. The
 * stream closes when `produce` resolves.
 *
 * `send` does not wait for the client. The events that the client has not
 * read wait in memory, up to 1 MiB. When more wait, the stream stops with an
 * error, and `signal` aborts with that error as its `reason`. On Bun, the
 * runtime reads the stream ahead of the client, so the limit does not apply.
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
	// Why negated: `NaN` fails each comparison, so it throws too.
	if (!(heartbeatMs >= 1 && heartbeatMs <= MAX_TIMER_MS)) {
		throw new RangeError(
			`eventStream needs a heartbeatMs from 1 to ${MAX_TIMER_MS}, not ${heartbeatMs}.`,
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
		if (open == null) {
			return;
		}
		open.enqueue(encoder.encode(text));
		// Why under 0: the size is `MAX_QUEUED_BYTES` less the bytes that wait for the client.
		if ((open.desiredSize ?? 0) < 0) {
			const error = new Error(
				"The event stream stopped: more than 1 MiB of events waited for the client.",
			);
			end()?.error(error);
			stopped.abort(error);
		}
	}

	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				open = controller;
			},
			cancel() {
				end();
				stopped.abort();
			},
		},
		QUEUE_STRATEGY,
	);
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
