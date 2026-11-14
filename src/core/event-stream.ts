import { shutdownSignal } from "./shutdown.js";

/** One server-sent event. */
export type ServerSentEvent = {
	data: string;
	event?: string;
	id?: string;
};

/** What {@link eventStream} passes to its producer. */
export type EventStreamSink = {
	/**
	 * Sends `event` at once. The promise resolves when the client has read
	 * the earlier events, down to 64 KiB of unread bytes, or when the stream
	 * ends. It never rejects. Await it, so that a slow client slows the
	 * producer. A stream with more than 1 MiB of unread bytes stops.
	 */
	send: (event: ServerSentEvent) => Promise<void>;
	/** Aborts while the stream is open: when the client disconnects or the server shuts down. Stop the work on it. */
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
	/**
	 * Extra response headers. A `Cache-Control` here takes the place of the default `no-cache`, so
	 * keep `no-cache` in it. `no-cache, no-transform` sends the stream with no compression: then
	 * `streamingCompress()` holds no encoder for the life of the stream, and the events take more bytes.
	 */
	headers?: HeadersInit;
};

/** Why: `setInterval` turns a longer delay, and a delay under 1, into 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** The unread bytes at which `send` makes the producer wait. */
const HIGH_WATER_BYTES = 64 * 1024;

/**
 * The unread bytes at which the stream stops. Why a limit: a producer that
 * does not await `send` would keep each event for a client that does not
 * read in memory. A producer that awaits `send` never gets near it.
 */
const MAX_UNREAD_BYTES = 1024 * 1024;

/** What `send` gives when the stream has room. Why one promise: a send with room allocates nothing. */
const ROOM = Promise.resolve();

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
 * Await `send`: it waits while the client has 64 KiB or more of events that
 * it has not read. When the unread events pass 1 MiB, the stream stops: the
 * response fails, and `signal` aborts.
 *
 * @example
 * export async function loader({ request }: Route.LoaderArgs) {
 * 	return eventStream(
 * 		async ({ send, signal }) => {
 * 			for await (const update of watchUpdates({ signal })) {
 * 				await send({ event: "update", data: JSON.stringify(update) });
 * 			}
 * 		},
 * 		{ signal: request.signal },
 * 	);
 * }
 */
export function eventStream(
	produce: (sink: EventStreamSink) => void | Promise<void>,
	{ signal, heartbeatMs = 15_000, headers }: EventStreamOptions = {},
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
	/** What each `send` that waits gives, and the function that resolves it. */
	let room: PromiseWithResolvers<void> | undefined;

	/** Ends the stream. It gives the controller to the first call only, to close or fail the body. */
	function end() {
		const controller = open;
		open = undefined;
		clearInterval(heartbeat);
		upstream.removeEventListener("abort", stop);
		release();
		return controller;
	}
	function release() {
		room?.resolve();
		room = undefined;
	}
	function close() {
		end()?.close();
	}
	function stop() {
		close();
		stopped.abort(upstream.reason);
	}
	function send(event: ServerSentEvent): Promise<void> {
		const controller = open;
		if (controller == null) {
			return ROOM;
		}
		controller.enqueue(encoder.encode(formatEvent(event)));
		// Why `?? 0`: the size is `null` only for an errored stream, and `open` is unset by then.
		const unread = HIGH_WATER_BYTES - (controller.desiredSize ?? 0);
		if (unread < HIGH_WATER_BYTES) {
			return ROOM;
		}
		if (unread > MAX_UNREAD_BYTES) {
			const error = new Error(
				`eventStream stopped: the client did not read ${unread} bytes of events. Await send().`,
			);
			end()?.error(error);
			stopped.abort(error);
			return ROOM;
		}
		room ??= Promise.withResolvers();
		return room.promise;
	}

	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				open = controller;
			},
			// Why: the stream calls it when the unread bytes fall under the high-water mark.
			pull: release,
			cancel() {
				end();
				stopped.abort();
			},
		},
		{ highWaterMark: HIGH_WATER_BYTES, size: (chunk) => chunk.byteLength },
	);
	if (upstream.aborted) {
		close();
	} else {
		heartbeat = setInterval(() => {
			// Why only with room: the client has events to read, and a ping would add to them.
			if ((open?.desiredSize ?? 0) > 0) {
				open?.enqueue(encoder.encode(": ping\n\n"));
			}
		}, heartbeatMs);
		upstream.addEventListener("abort", stop);
		Promise.resolve()
			.then(async () => produce({ send, signal: stopped.signal }))
			.then(close, (error: unknown) => {
				end()?.error(error);
			});
	}

	const responseHeaders = new Headers(headers);
	responseHeaders.set("Content-Type", "text/event-stream; charset=utf-8");
	// Why not `set`: an app can send `no-cache, no-transform` for a stream that must hold no encoder.
	if (!responseHeaders.has("Cache-Control")) {
		responseHeaders.set("Cache-Control", "no-cache");
	}
	return new Response(body, { headers: responseHeaders });
}
