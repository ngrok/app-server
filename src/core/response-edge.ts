import type { Context } from "hono";
import { replaceResponse } from "./header-hook.js";
import { errorAttributes } from "./log.js";
import type {
	AppServerEnv,
	HeaderHook,
	RequestLogger,
	ResponseHeaders,
	SentResponse,
} from "./types.js";

function ignore(): void {}

/** Calls `report` with `sent`, and drops a throw from it. */
function callReport(report: (sent: SentResponse) => void, sent: SentResponse): void {
	try {
		report(sent);
	} catch {
		// Why drop it: a listener calls a report from an event of its socket, where a throw stops the process.
	}
}

/**
 * What the server and a listener that writes each response itself share for
 * one request. The listener makes one for each request and gives it as the
 * `edge` binding. The server then runs the header hooks on a list of the
 * headers, so it copies no response for them. The listener:
 *
 * - writes {@link ResponseEdge.headersFor} in place of the headers of the response
 * - adds each body byte that it writes to {@link ResponseEdge.bytes}
 * - gives an error that stops the response to {@link ResponseEdge.fail}
 * - calls {@link ResponseEdge.close} once, when the response ends or its client goes away
 *
 * @example
 * const edge = new ResponseEdge();
 * const response = await fetch(request, { remoteAddress, edge });
 * outgoing.writeHead(response.status, edge.headersFor(response) ?? [...response.headers].flat());
 */
export class ResponseEdge {
	/** The body bytes that the listener gave to its socket. */
	public bytes = 0;
	#logger: RequestLogger | undefined = undefined;
	#response: Response | undefined = undefined;
	#headers: string[] | undefined = undefined;
	readonly #reports: ((sent: SentResponse) => void)[] = [];
	#sent: SentResponse | undefined = undefined;

	/**
	 * Gives the edge to the request of `logger`, and gives `true`, the first
	 * time only. The server calls it when a request starts. Why once: a
	 * request that the app sends through itself again with the same bindings
	 * must change its own response.
	 */
	public claim(logger: RequestLogger): boolean {
		if (this.#logger != null) {
			return false;
		}
		this.#logger = logger;
		return true;
	}

	/** Keeps the headers of `response` after each header hook. The server calls it. */
	public useHeaders(response: Response, headers: string[]): void {
		this.#response = response;
		this.#headers = headers;
	}

	/**
	 * The headers to write for `response`: lowercase names and their values in
	 * turn, as Node's `writeHead` takes them. It gives `undefined` when the
	 * server kept none for `response`, such as for a response that a wrapper
	 * around the server made.
	 */
	public headersFor(response: Response): string[] | undefined {
		return response === this.#response ? this.#headers : undefined;
	}

	/**
	 * Calls `report` once, when the response ends or its client goes away. It
	 * calls it at once when that happened already. A throw from `report` never
	 * reaches the listener.
	 */
	public onSent(report: (sent: SentResponse) => void): void {
		if (this.#sent == null) {
			this.#reports.push(report);
		} else {
			callReport(report, this.#sent);
		}
	}

	/** Logs `error`, which stopped the response, with the logger of the request. */
	public fail(error: unknown): void {
		try {
			if (this.#logger != null) {
				this.#logger.error("unhandled error", errorAttributes(error));
				return;
			}
		} catch {
			// Why fall through: the sink failed, and the error must still reach the operator.
		}
		// oxlint-disable-next-line no-console -- no app logger took the edge, or its sink failed.
		console.error(error);
	}

	/**
	 * Reports what went out, once: the status that the listener sent, the
	 * bytes, and whether the body stopped before its end.
	 */
	public close(status: number, aborted: boolean): void {
		if (this.#sent != null) {
			return;
		}
		this.#sent = { status, bytes: this.bytes, aborted };
		for (const report of this.#reports) {
			callReport(report, this.#sent);
		}
	}
}

/** The index of the lowercase `name` in a flat `[name, value, …]` header list, or -1. */
export function headerIndex(head: readonly string[], name: string): number {
	for (let index = 0; index < head.length; index += 2) {
		if (head[index] === name) {
			return index;
		}
	}
	return -1;
}

/** The flat `[name, value, …]` header list of `response`, with lowercase names. */
export function headerList(response: Response): string[] {
	const head: string[] = [];
	for (const [name, value] of response.headers) {
		head.push(name, value);
	}
	return head;
}

/**
 * A view of a flat `[name, value, …]` header list with lowercase names, for
 * the header hooks. It reads and changes the list as `Headers` does.
 */
function listView(head: string[]): ResponseHeaders {
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
		has: (name) => headerIndex(head, name.toLowerCase()) !== -1,
		set: (name, value) => {
			const lower = name.toLowerCase();
			remove(lower);
			head.push(lower, value);
		},
		append: (name, value) => {
			const lower = name.toLowerCase();
			const index = lower === "set-cookie" ? -1 : headerIndex(head, lower);
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

/**
 * `body` again, with a count of its bytes for `report`. `report` runs once:
 * at the end of the body, at a failure, or at a cancel.
 */
function countedBody(
	body: ReadableStream<Uint8Array>,
	report: (bytes: number, aborted: boolean) => void,
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let bytes = 0;
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				let result: ReadableStreamReadResult<Uint8Array>;
				try {
					result = await reader.read();
				} catch (error) {
					// Why here: `cancel` does not run for a stream that failed.
					report(bytes, true);
					throw error;
				}
				if (result.done) {
					controller.close();
					report(bytes, false);
					return;
				}
				bytes += result.value.byteLength;
				controller.enqueue(result.value);
			},
			async cancel(reason) {
				try {
					report(bytes, true);
				} finally {
					await reader.cancel(reason);
				}
			},
		},
		// Why 0: a pass-through stream must not read ahead of the client.
		{ highWaterMark: 0 },
	);
}

/**
 * The body of `response` with a count for `report`, or `undefined` when
 * `report` ran at once: a HEAD response and a response with no body send no
 * body bytes.
 */
function reportedBody(
	context: Context<AppServerEnv>,
	response: Response,
	report: (sent: SentResponse) => void,
): ReadableStream<Uint8Array> | undefined {
	const { status, body } = response;
	// Why HEAD: Hono drops the body of a HEAD response, so no one reads it to its end.
	if (context.req.method === "HEAD") {
		callReport(report, { status, bytes: 0, aborted: false });
		return undefined;
	}
	// Why `Content-Length`: a stage that answers through Node's response, such as Vite in
	// development, gives a response with no body and the length it sent.
	if (body == null) {
		const length = Number(response.headers.get("Content-Length") ?? 0);
		callReport(report, { status, bytes: length, aborted: false });
		return undefined;
	}
	return countedBody(body, (bytes, aborted) => {
		callReport(report, { status, bytes, aborted });
	});
}

/**
 * Calls `report` once, when the response of the request ends or its client
 * goes away: with the status that went out, the body bytes, and whether the
 * body stopped before its end. In an app server, it reports the response that
 * the server returns, after each stage and header hook. A listener with an
 * `edge` counts the bytes as it writes them; else the server counts them with
 * a stream around the body.
 *
 * @example
 * middleware: async (c, next) => {
 * 	await next();
 * 	onResponseSent(c, ({ status, bytes }) => c.get("logger").info("sent", { status, bytes }));
 * },
 */
export function onResponseSent(
	context: Context<AppServerEnv>,
	report: (sent: SentResponse) => void,
): void {
	const reports = context.get("sentReports");
	if (reports != null) {
		reports.push(report);
		return;
	}
	// Why now: outside an app server, nothing reports later, so this counts the response as it is.
	const response = context.res;
	const body = reportedBody(context, response, report);
	if (body != null) {
		replaceResponse(context, new Response(body, response));
	}
}

/** What {@link finishResponse} needs from the server. */
type Finish = {
	hooks: readonly HeaderHook[];
	reports: readonly ((sent: SentResponse) => void)[];
	/** The edge that the request claimed, if any. */
	edge: ResponseEdge | undefined;
	/**
	 * The response for an error that a header hook throws, as `onError` gives
	 * it. It runs while `context.res` is cleared.
	 */
	fail: (error: unknown, context: Context<AppServerEnv>) => Response;
};

/**
 * Puts the response that `fail` gives for `error` in place of the response of
 * the request, and cancels the body that no one reads now.
 */
function useErrorResponse(
	context: Context<AppServerEnv>,
	fail: Finish["fail"],
	error: unknown,
): void {
	const { body } = context.res;
	// Why clear first: Hono's `c.text` copies each header of the response that the context holds.
	context.res = undefined;
	context.res = fail(error, context);
	void body?.cancel().catch(ignore);
}

/**
 * Finishes the response of the request, after each stage. The server calls it
 * once.
 *
 * - It runs `hooks` on the head, in reverse order, so the hook of an inner
 *   stage runs first and an outer stage has the last word. When a hook
 *   throws, `fail` gives the response that takes the place of this one, and
 *   the hooks of the outer stages run on it, as when a stage throws.
 * - It gives `reports` the response, so each one runs when it ends.
 *
 * With `edge`, the head stays a list that the listener writes, so the server
 * copies no response. Else the server makes one new response with the head
 * and a body that counts its bytes.
 */
export function finishResponse(
	context: Context<AppServerEnv>,
	{ hooks, reports, edge, fail }: Finish,
): void {
	let head = headerList(context.res);
	let view = listView(head);
	for (let index = hooks.length - 1; index >= 0; index -= 1) {
		try {
			hooks[index]?.(view);
		} catch (error) {
			useErrorResponse(context, fail, error);
			head = headerList(context.res);
			view = listView(head);
		}
	}
	if (edge != null) {
		edge.useHeaders(context.res, head);
		for (const report of reports) {
			edge.onSent(report);
		}
		return;
	}
	let headers: Headers | undefined;
	if (hooks.length > 0) {
		try {
			headers = new Headers();
			for (let index = 0; index < head.length; index += 2) {
				headers.append(head[index] ?? "", head[index + 1] ?? "");
			}
		} catch (error) {
			// Why: a hook set a value that `Headers` rejects. The error response keeps its own headers.
			useErrorResponse(context, fail, error);
			headers = undefined;
		}
	}
	const response = context.res;
	const [only] = reports;
	const report =
		reports.length > 1
			? (sent: SentResponse) => {
					for (const each of reports) {
						callReport(each, sent);
					}
				}
			: only;
	const body = report == null ? undefined : reportedBody(context, response, report);
	if (headers == null && body == null) {
		return;
	}
	context.res = undefined;
	context.res = new Response(body ?? response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: headers ?? response.headers,
	});
}
