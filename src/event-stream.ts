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
	/** Aborts when the client disconnects or the server shuts down. Stop the work on it. */
	signal: AbortSignal;
};

/** Options for {@link eventStream}. */
export type EventStreamOptions = {
	/** The request's signal, so a client disconnect stops the stream. */
	signal?: AbortSignal;
	/**
	 * How often a `: ping` comment goes out, so that a proxy keeps a quiet stream open.
	 * @default 15000
	 */
	heartbeatMs?: number;
	/** Extra response headers. */
	headers?: HeadersInit;
};

function formatEvent({ data, event, id }: ServerSentEvent): string {
	// Why: a line break in `event` or `id` would start another field or event.
	if (/[\r\n]/.test(`${event ?? ""}${id ?? ""}`)) {
		throw new TypeError("An event's `event` and `id` cannot contain a line break.");
	}
	const lines = [
		...(event == null ? [] : [`event: ${event}`]),
		...(id == null ? [] : [`id: ${id}`]),
		// Why `\r` too: a client reads a lone carriage return as a line end.
		...data.split(/\r\n|\r|\n/).map((line) => `data: ${line}`),
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
	const encoder = new TextEncoder();
	const stopped = new AbortController();
	const stopSignal = AbortSignal.any([
		stopped.signal,
		shutdownSignal(),
		...(signal == null ? [] : [signal]),
	]);
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let closed = false;

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const close = () => {
				if (closed) {
					return;
				}
				closed = true;
				clearInterval(heartbeat);
				// Why: the listener lives on `shutdownSignal()`, which lasts the life of the process.
				stopSignal.removeEventListener("abort", close);
				controller.close();
			};
			const write = (text: string) => {
				if (!closed) {
					controller.enqueue(encoder.encode(text));
				}
			};
			heartbeat = setInterval(() => {
				write(": ping\n\n");
			}, heartbeatMs);
			stopSignal.addEventListener("abort", close, { once: true });
			if (stopSignal.aborted) {
				close();
				return;
			}
			Promise.resolve()
				.then(() => produce({ send: (event) => write(formatEvent(event)), signal: stopSignal }))
				.then(close, (error: unknown) => {
					closed = true;
					clearInterval(heartbeat);
					stopSignal.removeEventListener("abort", close);
					controller.error(error);
				});
		},
		cancel() {
			closed = true;
			clearInterval(heartbeat);
			stopped.abort();
		},
	});

	const responseHeaders = new Headers(headers);
	responseHeaders.set("Content-Type", "text/event-stream; charset=utf-8");
	responseHeaders.set("Cache-Control", "no-cache");
	return new Response(body, { headers: responseHeaders });
}
