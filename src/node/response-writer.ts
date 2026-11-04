import { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { readIfQueued } from "../core/compression.js";
import type { ReadResult } from "../core/compression.js";
import type {
	HeaderHook,
	ListenerBindings,
	ResponseEdge,
	ResponseHeaders,
	SentBody,
} from "../core/types.js";
import type { NodeBindings } from "./dev-server.js";
import { waitsForZlib } from "./gzip.js";

/** The header of a response that went out through Node's response already, as the dev server stage sends it. */
const ALREADY_SENT_HEADER = "x-hono-already-sent";
/** Why one object for all requests: `@hono/node-server` only reads its headers. */
const ALREADY_SENT = new Response(null, { headers: { [ALREADY_SENT_HEADER]: "true" } });
/** The type that `@hono/node-server` gives a body with none. */
const DEFAULT_CONTENT_TYPE = "text/plain; charset=UTF-8";

/** Calls `report` with `sent`, and drops a throw from it. */
function callReport(report: (sent: SentBody) => void, sent: SentBody): void {
	try {
		report(sent);
	} catch {
		// Why drop it: the report runs in an event of Node's response, where a throw stops the process.
	}
}

/** The edge of one request: the header hooks for the head, and the count of the body bytes. */
class NodeEdge implements ResponseEdge {
	public bytes = 0;
	public hooks: readonly HeaderHook[] = [];
	#report: ((sent: SentBody) => void) | undefined = undefined;
	#sent: SentBody | undefined = undefined;

	public useHeaderHooks(hooks: readonly HeaderHook[]): void {
		this.hooks = hooks;
	}

	public onSent(report: (sent: SentBody) => void): void {
		if (this.#sent == null) {
			this.#report = report;
		} else {
			callReport(report, this.#sent);
		}
	}

	/** Reports the bytes once. */
	public close(aborted: boolean): void {
		if (this.#sent != null) {
			return;
		}
		this.#sent = { bytes: this.bytes, aborted };
		if (this.#report != null) {
			callReport(this.#report, this.#sent);
		}
	}
}

/** The index of the lowercase `name` in a flat `[name, value, …]` header list, or -1. */
function indexOf(head: string[], name: string): number {
	for (let index = 0; index < head.length; index += 2) {
		if (head[index] === name) {
			return index;
		}
	}
	return -1;
}

/**
 * A view of a flat `[name, value, …]` header list with lowercase names, for
 * the header hooks. Why no `Headers`: the hooks change the list that
 * `writeHead` takes, so the response needs no copy.
 */
function headView(head: string[]): ResponseHeaders {
	const remove = (name: string) => {
		for (let index = head.length - 2; index >= 0; index -= 2) {
			if (head[index] === name) {
				head.splice(index, 2);
			}
		}
	};
	const get = (name: string) => {
		const lower = name.toLowerCase();
		let value: string | null = null;
		for (let index = 0; index < head.length; index += 2) {
			if (head[index] === lower) {
				value = value == null ? (head[index + 1] ?? "") : `${value}, ${head[index + 1] ?? ""}`;
			}
		}
		return value;
	};
	return {
		get,
		has: (name) => indexOf(head, name.toLowerCase()) !== -1,
		set: (name, value) => {
			const lower = name.toLowerCase();
			remove(lower);
			head.push(lower, value);
		},
		append: (name, value) => {
			const lower = name.toLowerCase();
			const index = lower === "set-cookie" ? -1 : indexOf(head, lower);
			// Why join: `Headers` sends the values of a name on one line, except each `Set-Cookie`.
			if (index === -1) {
				head.push(lower, value);
			} else {
				head[index + 1] = `${head[index + 1] ?? ""}, ${value}`;
			}
		},
		delete: (name) => {
			remove(name.toLowerCase());
		},
	};
}

/** Resolves after the microtasks that are queued now, and the ones that they queue. */
async function afterMicrotasks(): Promise<void> {
	return new Promise((resolve) => {
		process.nextTick(resolve);
	});
}

/** Resolves on the next `drain` of `outgoing`, or when it closes. */
async function drained(outgoing: ServerResponse): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			outgoing.off("drain", done);
			outgoing.off("close", done);
			resolve();
		};
		outgoing.on("drain", done);
		outgoing.on("close", done);
	});
}

/** The flat `[name, value, …]` head of `response`, after `hooks`, for `writeHead`. */
function headOf(response: Response, hooks: readonly HeaderHook[]): string[] {
	const head: string[] = [];
	for (const [name, value] of response.headers) {
		head.push(name, value);
	}
	const view = headView(head);
	// Why reversed: the hook of an inner stage runs first, so an outer stage has the last word.
	for (let index = hooks.length - 1; index >= 0; index -= 1) {
		hooks[index]?.(view);
	}
	if (response.body != null && indexOf(head, "content-type") === -1) {
		head.push("content-type", DEFAULT_CONTENT_TYPE);
	}
	return head;
}

/** The chunks that a body had queued in at most two reads, and the read that is still open. */
type Ahead = {
	chunks: Uint8Array[];
	size: number;
	done: boolean;
	pending: Promise<ReadResult> | undefined;
};

/**
 * Reads the chunks that `body` has queued, in at most two reads, and never
 * waits for its source. The exception is a stream of the host's gzip whose
 * source gave bytes: it waits for zlib's first chunk, so the head goes out
 * with it.
 */
async function readAhead(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	body: ReadableStream<Uint8Array>,
): Promise<Ahead> {
	const ahead: Ahead = { chunks: [], size: 0, done: false, pending: undefined };
	for (let reads = 0; reads < 2 && !ahead.done && ahead.pending == null; reads += 1) {
		// oxlint-disable-next-line no-await-in-loop -- each read takes only a chunk that is queued already.
		let next = await readIfQueued(reader);
		if ("pending" in next && reads === 0 && waitsForZlib(body) != null) {
			// Why wait: the host's gzip stream gets its source chunk in a later microtask.
			// oxlint-disable-next-line no-await-in-loop -- this runs on the first read only.
			await afterMicrotasks();
			if (waitsForZlib(body) === true) {
				// oxlint-disable-next-line no-await-in-loop -- this runs on the first read only.
				next = { result: await next.pending };
			}
		}
		if ("pending" in next) {
			ahead.pending = next.pending;
		} else if (next.result.done) {
			ahead.done = true;
		} else {
			ahead.chunks.push(next.result.value);
			ahead.size += next.result.value.byteLength;
		}
	}
	return ahead;
}

/** Throws when a body that ended gave fewer bytes than its `Content-Length`. */
function checkLength(bytes: number, length: number | undefined): void {
	if (length != null && bytes < length) {
		throw new Error("The body ended before its Content-Length.");
	}
}

/** Writes the rest of the body at the pace of the client, then ends the response. */
async function pump(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	first: Promise<ReadResult>,
	{
		outgoing,
		edge,
		length,
	}: { outgoing: ServerResponse; edge: NodeEdge; length: number | undefined },
): Promise<void> {
	let read = first;
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- the next read waits for the socket.
		const result = await read;
		if (outgoing.destroyed) {
			return;
		}
		if (result.done) {
			checkLength(edge.bytes, length);
			outgoing.end();
			return;
		}
		edge.bytes += result.value.byteLength;
		if (!outgoing.write(result.value)) {
			// oxlint-disable-next-line no-await-in-loop -- the client sets the pace.
			await drained(outgoing);
		}
		read = reader.read();
	}
}

/**
 * Writes `response` to `outgoing`. It runs the header hooks of `edge` on the
 * head, and counts the body bytes in `edge`. It never rejects.
 *
 * - A body that ends within the chunks that it has queued goes out with its
 *   `Content-Length`, in one socket write with the head.
 * - When the first chunk is not ready, the head goes out at once, so an event
 *   stream opens at once. A stream of the host's gzip whose source gave bytes
 *   is the exception: zlib finishes it soon, so the head waits for it.
 * - It reads the next chunk only when Node takes the last one, and it cancels
 *   the body when the socket closes.
 * - A body that fails, or that ends before its `Content-Length`, destroys the
 *   socket, so no client and no cache keeps a cut response as complete.
 */
async function writeResponse(
	response: Response,
	outgoing: ServerResponse,
	edge: NodeEdge,
): Promise<void> {
	const { body, status } = response;
	// Why: the dev server stage answered through Node's response.
	if (body == null && response.headers.has(ALREADY_SENT_HEADER)) {
		return;
	}
	if (outgoing.destroyed) {
		edge.close(true);
		await body?.cancel().catch(() => {});
		return;
	}
	const reader = body?.getReader();
	// Why one listener: it reports the bytes and stops the body that the client no longer reads.
	// Why `on`: a response emits `close` once, and `once` adds a wrapper for each request.
	outgoing.on("close", () => {
		edge.close(!outgoing.writableFinished);
		reader?.cancel().catch(() => {});
	});
	try {
		const head = headOf(response, edge.hooks);
		if (body == null || reader == null) {
			outgoing.writeHead(status, head);
			outgoing.end();
			return;
		}
		const index = indexOf(head, "content-length");
		const length = index === -1 ? undefined : Number(head[index + 1]);
		const ahead = await readAhead(reader, body);
		if (outgoing.destroyed) {
			return;
		}
		if (ahead.done) {
			checkLength(ahead.size, length);
			if (length == null && indexOf(head, "transfer-encoding") === -1) {
				head.push("content-length", String(ahead.size));
			}
			outgoing.writeHead(status, head);
			edge.bytes += ahead.size;
			outgoing.end(ahead.chunks.length === 1 ? ahead.chunks[0] : Buffer.concat(ahead.chunks));
			return;
		}
		outgoing.writeHead(status, head);
		for (const chunk of ahead.chunks) {
			edge.bytes += chunk.byteLength;
			outgoing.write(chunk);
		}
		if (ahead.chunks.length === 0) {
			// Why: the client gets the head at once, such as the open of an event stream.
			outgoing.flushHeaders();
		}
		await pump(reader, ahead.pending ?? reader.read(), { outgoing, edge, length });
	} catch (error) {
		reader?.cancel(error).catch(() => {});
		// oxlint-disable-next-line no-console -- the writer runs after the pipeline and its logger, as `@hono/node-server`'s writer does.
		console.error(error);
		outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
	}
}

/**
 * Runs `create`, which makes a listener of `@hono/node-server`, and keeps the
 * global `Response`. The listener makes its own `Request` class global.
 *
 * Why its `Request`: the listener gives each route a light request, and only
 * that class can copy it, such as `new Request(c.req.raw, init)` in Hono's
 * `methodOverride`. Why not its `Response`: a `fetch()` result must stay an
 * `instanceof Response`, as on Bun and Deno.
 *
 * @example
 * const listener = keepGlobalResponse(() => getRequestListener(app.fetch));
 */
export function keepGlobalResponse<T>(create: () => T): T {
	// Why the descriptor: on Deno, the listener leaves a `Response` that no one can assign.
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Response");
	try {
		return create();
	} finally {
		if (descriptor != null) {
			Object.defineProperty(globalThis, "Response", descriptor);
		}
	}
}

/** A `Host` header that a URL keeps as it is: a name or an address, and an optional port. */
const VALID_HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/iu;

/**
 * Gives `incoming` an absolute target with the scheme of its
 * `X-Forwarded-Proto`. Why: `@hono/node-server` takes the scheme from the
 * socket, which is plain HTTP behind a proxy that ends TLS. A target with the
 * scheme gives the request its URL when it is made, so the server copies no
 * request to change it. `incoming.url` is then the absolute URL.
 */
function useForwardedProto(incoming: IncomingMessage): void {
	const { host, "x-forwarded-proto": proto } = incoming.headers;
	if (
		(proto === "https" || proto === "http") &&
		host != null &&
		VALID_HOST.test(host) &&
		incoming.url?.startsWith("/") === true
	) {
		incoming.url = `${proto}://${host}${incoming.url}`;
	}
}

/**
 * Why not on Bun and Deno: their `node:http` does not always emit `close` or
 * set `destroyed`, so `@hono/node-server` writes the response there.
 */
const writesResponses = !("Bun" in globalThis) && !("Deno" in globalThis);

/**
 * A `node:http` request listener. `@hono/node-server` builds each request,
 * `answer` makes the response, and the listener writes it. Each HTTP/1
 * request on Node.js gets an `edge` binding, so the server leaves its header
 * hooks to the head and the access log takes the bytes from the listener.
 * With `trustForwardedProto`, each request takes its scheme from
 * `X-Forwarded-Proto`, as the server option does.
 *
 * @example
 * http.createServer(requestListener(async (request, bindings) => app.fetch(request, bindings)));
 */
export function requestListener(
	answer: (request: Request, bindings: NodeBindings) => Response | Promise<Response>,
	{ trustForwardedProto = false }: { trustForwardedProto?: boolean } = {},
): ReturnType<typeof getRequestListener> {
	const listener = listenerOf(answer);
	return trustForwardedProto
		? async (incoming, outgoing) => {
				if (incoming instanceof IncomingMessage) {
					useForwardedProto(incoming);
				}
				return listener(incoming, outgoing);
			}
		: listener;
}

/** The listener of {@link requestListener}, with no scheme from `X-Forwarded-Proto`. */
function listenerOf(
	answer: (request: Request, bindings: NodeBindings) => Response | Promise<Response>,
): ReturnType<typeof getRequestListener> {
	return keepGlobalResponse(() =>
		getRequestListener(async (request, { incoming, outgoing }) => {
			const { remoteAddress } = incoming.socket;
			// Why: an HTTP/2 response is not a `ServerResponse`, so `@hono/node-server` writes it.
			if (!(incoming instanceof IncomingMessage) || !(outgoing instanceof ServerResponse)) {
				return answer(request, { remoteAddress } satisfies ListenerBindings);
			}
			if (!writesResponses) {
				const response = await answer(request, { remoteAddress, incoming, outgoing });
				// Why: `@hono/node-server` drops the body of a response whose socket closed, with no cancel.
				if (outgoing.destroyed) {
					await response.body?.cancel();
				}
				return response;
			}
			const edge = new NodeEdge();
			let response: Response;
			try {
				response = await answer(request, { remoteAddress, incoming, outgoing, edge });
			} catch (error) {
				edge.close(true);
				throw error;
			}
			await writeResponse(response, outgoing, edge);
			return ALREADY_SENT;
		}),
	);
}
