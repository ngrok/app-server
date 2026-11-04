import { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { readIfQueued } from "../core/compression.js";
import type { ReadResult } from "../core/compression.js";
import { headerIndex, headerList } from "../core/header-hook.js";
import { ResponseEdge } from "../core/response-edge.js";
import type { ListenerBindings } from "../core/types.js";
import type { NodeBindings } from "./dev-server.js";
import { waitsForZlib } from "./gzip.js";

/** The header of a response that went out through Node's response already, as the dev server stage sends it. */
const ALREADY_SENT_HEADER = "x-hono-already-sent";
/** Why one object for all requests: `@hono/node-server` only reads its headers. */
const ALREADY_SENT = new Response(null, { headers: { [ALREADY_SENT_HEADER]: "true" } });
/** The type that `@hono/node-server` gives a body with none. */
const DEFAULT_CONTENT_TYPE = "text/plain; charset=UTF-8";
/** The body of the 500 that goes out when the response cannot. */
const ERROR_BODY = Buffer.from("Internal Server Error");

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

/** `value` as a body chunk. Why throw: a string chunk has no `byteLength`, and the Fetch standard allows bytes only. */
function bytesOf(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) {
		return value;
	}
	throw new TypeError("A response body gave a chunk that is not a Uint8Array.");
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
			const chunk = bytesOf(next.result.value);
			ahead.chunks.push(chunk);
			ahead.size += chunk.byteLength;
		}
	}
	return ahead;
}

/**
 * Writes the rest of the body at the pace of the client, then ends the
 * response. Why no length check: `strictContentLength` makes Node throw for a
 * body that does not match its `Content-Length`.
 */
async function pump(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	first: Promise<ReadResult>,
	{ outgoing, edge }: { outgoing: ServerResponse; edge: ResponseEdge },
): Promise<void> {
	let read = first;
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- the next read waits for the socket.
		const result = await read;
		if (outgoing.destroyed) {
			return;
		}
		if (result.done) {
			outgoing.end();
			return;
		}
		const chunk = bytesOf(result.value);
		const flowing = outgoing.write(chunk);
		edge.bytes += chunk.byteLength;
		if (!flowing) {
			// oxlint-disable-next-line no-await-in-loop -- the client sets the pace.
			await drained(outgoing);
		}
		read = reader.read();
	}
}

/** The headers that `outgoing` sent, as a flat list. Why: the dev server stage sends its own head. */
function sentHead(outgoing: ServerResponse): string[] {
	const head: string[] = [];
	for (const [name, value] of Object.entries(outgoing.getHeaders())) {
		for (const each of Array.isArray(value) ? value : [value]) {
			if (each != null) {
				head.push(name, String(each));
			}
		}
	}
	return head;
}

/** Writes the head and the body of `response`, with `head` in place of its headers. */
async function writeBody(
	response: Response,
	reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
	{ outgoing, edge, head }: { outgoing: ServerResponse; edge: ResponseEdge; head: string[] },
): Promise<void> {
	const { body, status } = response;
	if (body == null || reader == null) {
		outgoing.writeHead(status, head);
		outgoing.end();
		return;
	}
	if (headerIndex(head, "content-type") === -1) {
		head.push("content-type", DEFAULT_CONTENT_TYPE);
	}
	const ahead = await readAhead(reader, body);
	if (outgoing.destroyed) {
		return;
	}
	if (ahead.done) {
		const index = headerIndex(head, "content-length");
		if (index === -1 && headerIndex(head, "transfer-encoding") === -1) {
			head.push("content-length", String(ahead.size));
		} else if (index !== -1 && Number(head[index + 1]) !== ahead.size) {
			throw new Error("The body does not match its Content-Length.");
		}
		outgoing.writeHead(status, head);
		outgoing.end(ahead.chunks.length === 1 ? ahead.chunks[0] : Buffer.concat(ahead.chunks));
		edge.bytes += ahead.size;
		return;
	}
	outgoing.writeHead(status, head);
	for (const chunk of ahead.chunks) {
		outgoing.write(chunk);
		edge.bytes += chunk.byteLength;
	}
	if (ahead.chunks.length === 0) {
		// Why: the client gets the head at once, such as the open of an event stream.
		outgoing.flushHeaders();
	}
	await pump(reader, ahead.pending ?? reader.read(), { outgoing, edge });
}

/**
 * Writes `response` to `outgoing`, with the headers that the server gave
 * `edge` for it, and counts the body bytes in `edge`. It never rejects.
 *
 * - A body that ends within two reads of the chunks that it has queued goes
 *   out with its `Content-Length`, in one socket write with the head.
 * - When the first chunk is not ready, the head goes out at once, so an event
 *   stream opens at once. A stream of the host's gzip whose source gave bytes
 *   is the exception: zlib finishes it soon, so the head waits for it.
 * - It reads the next chunk only when Node takes the last one, and it cancels
 *   the body when the socket closes.
 * - When a step fails before the head goes out, such as a body that fails or
 *   a header that Node rejects, a 500 goes out. After the head, a failure or
 *   a body that does not match its `Content-Length` destroys the socket, so
 *   no client and no cache keeps a cut response as complete.
 */
async function writeResponse(
	response: Response,
	outgoing: ServerResponse,
	edge: ResponseEdge,
): Promise<void> {
	const { body } = response;
	let { status } = response;
	const sendsBody = outgoing.req.method !== "HEAD";
	if (body == null && response.headers.has(ALREADY_SENT_HEADER)) {
		// Why: the dev server stage answered through Node's response, and gave its status and length.
		// Node sends no body for HEAD.
		edge.bytes = sendsBody ? Number(response.headers.get("content-length") ?? 0) : 0;
		edge.close(status, false, sentHead(outgoing));
		return;
	}
	// Why one list: `writeBody` adds the headers that it sets, so the report gets the head that went out.
	let head = edge.headersFor(response) ?? headerList(response.headers);
	if (outgoing.destroyed) {
		edge.close(status, true, head);
		await body?.cancel().catch(() => {});
		return;
	}
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	// Why one listener: it reports what went out and stops the body that the client no longer reads.
	// Why `on`: a response emits `close` once, and `once` adds a wrapper for each request.
	outgoing.on("close", () => {
		edge.close(status, !outgoing.writableFinished, head);
		reader?.cancel().catch(() => {});
	});
	try {
		reader = body?.getReader();
		// Why strict: Node then throws for a body that is longer or shorter than its `Content-Length`.
		outgoing.strictContentLength = true;
		await writeBody(response, reader, { outgoing, edge, head });
	} catch (error) {
		reader?.cancel(error).catch(() => {});
		edge.fail(error);
		if (outgoing.headersSent || outgoing.destroyed) {
			outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		status = 500;
		head = ["content-type", DEFAULT_CONTENT_TYPE, "content-length", String(ERROR_BODY.byteLength)];
		outgoing.writeHead(status, head);
		outgoing.end(ERROR_BODY);
		if (sendsBody) {
			edge.bytes += ERROR_BODY.byteLength;
		}
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

/** The request target that the client sent, on a request that {@link useForwardedProto} changed. */
const SENT_TARGET = Symbol("sentTarget");

/** A Node request whose target can carry the target that the client sent. */
type Targeted = IncomingMessage & { [SENT_TARGET]?: string };

/**
 * Gives `incoming` an absolute target with the scheme of its
 * `X-Forwarded-Proto`. Why: `@hono/node-server` takes the scheme from the
 * socket, which is plain HTTP behind a proxy that ends TLS. A target with the
 * scheme gives the request its URL when it is made, so the server copies no
 * request to change it. {@link listenerOf} then puts the target that the
 * client sent back.
 */
function useForwardedProto(incoming: Targeted): void {
	const { host, "x-forwarded-proto": proto } = incoming.headers;
	const target = incoming.url;
	if (
		(proto === "https" || proto === "http") &&
		host != null &&
		VALID_HOST.test(host) &&
		target?.startsWith("/") === true
	) {
		incoming[SENT_TARGET] = target;
		// Why drop `:80` for https: a proxy can send the port of its own hop, and the server took the
		// scheme from the socket first, where 80 is the default port, so the URL never kept it.
		const authority = proto === "https" && host.endsWith(":80") ? host.slice(0, -3) : host;
		incoming.url = `${proto}://${authority}${target}`;
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
 * request on Node.js gets an `edge` binding, so the server gives the listener
 * the headers after its header hooks, and the access log takes the bytes from
 * the listener.
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
			const targeted: Targeted = incoming;
			const target = targeted[SENT_TARGET];
			// Why: the request has its URL now, and the app gets the target that the client sent.
			if (target != null) {
				incoming.url = target;
			}
			if (!writesResponses) {
				const response = await answer(request, { remoteAddress, incoming, outgoing });
				// Why: `@hono/node-server` drops the body of a response whose socket closed, with no cancel.
				if (outgoing.destroyed) {
					await response.body?.cancel();
				}
				return response;
			}
			const edge = new ResponseEdge();
			let response: Response;
			try {
				response = await answer(request, { remoteAddress, incoming, outgoing, edge });
			} catch (error) {
				// Why 500 with no headers: `@hono/node-server` answers a failed request with one.
				edge.close(500, false, []);
				throw error;
			}
			await writeResponse(response, outgoing, edge);
			return ALREADY_SENT;
		}),
	);
}
