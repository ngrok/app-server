import type { Context } from "hono";
import { headerIndex, headerList, listView, replaceResponse } from "./header-hook.js";
import { asError } from "./log.js";
import type { AppServerEnv, HeaderHook, RequestLogger, SentResponse, ServerEnv } from "./types.js";

function ignore(): void {}

/** Calls `report` with `sent`, and drops a throw from it. */
function callReport(report: (sent: SentResponse) => void, sent: SentResponse): void {
	try {
		report(sent);
	} catch {
		// Why drop it: a listener calls a report from an event of its socket, where a throw stops the process.
	}
}

/** The `Set-Cookie` values of a flat header list, one on each line. */
function cookiesOf(head: readonly string[]): string {
	let cookies = "";
	for (let index = 0; index < head.length; index += 2) {
		if (head[index] === "set-cookie") {
			cookies += `${head[index + 1] ?? ""}\n`;
		}
	}
	return cookies;
}

/** The value of the lowercase `name` in a flat header list with one entry for each name, or `undefined`. */
function valueOf(head: readonly string[], name: string): string | undefined {
	const index = headerIndex(head, name);
	return index === -1 ? undefined : head[index + 1];
}

/** Whether two flat header lists are the same. */
function sameHead(first: readonly string[], second: readonly string[]): boolean {
	if (first.length !== second.length) {
		return false;
	}
	for (let index = 0; index < first.length; index += 1) {
		if (first[index] !== second[index]) {
			return false;
		}
	}
	return true;
}

/** `head` with the changes from `base` to `live`, two lists of the headers of the response before the hooks. */
function withChanges(
	head: readonly string[],
	base: readonly string[],
	live: readonly string[],
): string[] {
	const changed = [...head];
	const view = listView(changed);
	for (let index = 0; index < base.length; index += 2) {
		const name = base[index] ?? "";
		if (headerIndex(live, name) === -1) {
			view.delete(name);
		}
	}
	if (cookiesOf(base) !== cookiesOf(live)) {
		view.delete("set-cookie");
		for (let index = 0; index < live.length; index += 2) {
			if (live[index] === "set-cookie") {
				view.append("set-cookie", live[index + 1] ?? "");
			}
		}
	}
	for (let index = 0; index < live.length; index += 2) {
		const name = live[index] ?? "";
		const value = live[index + 1] ?? "";
		if (name !== "set-cookie" && valueOf(base, name) !== value) {
			view.set(name, value);
		}
	}
	return changed;
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
	#base: readonly string[] | undefined = undefined;
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

	/**
	 * Keeps `headers`, the headers of the response after each header hook, and
	 * `base`, its headers before the hooks. The server calls it.
	 */
	public useHeaders({ base, headers }: { base: readonly string[]; headers: string[] }): void {
		this.#base = base;
		this.#headers = headers;
	}

	/**
	 * The headers to write for `response`: lowercase names and their values in
	 * turn, as Node's `writeHead` takes them. They are the headers after the
	 * hooks, with each change that the headers of `response` have from the
	 * response that the hooks ran on. Why: Hono answers HEAD with a copy that
	 * has no body, and a wrapper of the app's `fetch` can change the headers or
	 * return a copy. It gives `undefined` when the server kept no headers.
	 */
	public headersFor(response: Response): string[] | undefined {
		const base = this.#base;
		const headers = this.#headers;
		if (base == null || headers == null) {
			return headers;
		}
		const live = headerList(response.headers);
		return sameHead(base, live) ? headers : withChanges(headers, base, live);
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
				this.#logger.error("unhandled error", { error: asError(error) });
				return;
			}
		} catch {
			// Why fall through: the sink failed, and the error must still reach the operator.
		}
		// oxlint-disable-next-line no-console -- no app logger took the edge, or its sink failed.
		console.error(error);
	}

	/**
	 * Reports what went out, once: `status`, the headers that the listener
	 * sent, the bytes, and `aborted`, which says whether the body stopped
	 * before its end. `head` is the flat list that the listener gave
	 * `writeHead`.
	 */
	public close({
		status,
		aborted,
		head,
	}: {
		status: number;
		aborted: boolean;
		head: string[];
	}): void {
		if (this.#sent != null) {
			return;
		}
		this.#sent = { status, headers: listView(head), bytes: this.bytes, aborted };
		for (const report of this.#reports) {
			callReport(report, this.#sent);
		}
	}
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
 * The body of `context.res` with a count for `report`, or `undefined` when
 * `report` ran at once: a HEAD response and a response with no body send no
 * body bytes. `headers` are the headers that go out with the response.
 */
function reportedBody(
	context: Context<AppServerEnv>,
	headers: Headers,
	report: (sent: SentResponse) => void,
): ReadableStream<Uint8Array> | undefined {
	const { status, body } = context.res;
	// Why HEAD: Hono drops the body of a HEAD response, so no one reads it to its end.
	if (context.req.method === "HEAD") {
		callReport(report, { status, headers, bytes: 0, aborted: false });
		return undefined;
	}
	// Why `Content-Length`: a stage that answers through Node's response, such as Vite in
	// development, gives a response with no body and the length it sent.
	if (body == null) {
		const length = Number(headers.get("Content-Length") ?? 0);
		callReport(report, { status, headers, bytes: length, aborted: false });
		return undefined;
	}
	return countedBody(body, (bytes, aborted) => {
		callReport(report, { status, headers, bytes, aborted });
	});
}

/**
 * Calls `report` once, when the response of the request ends or its client
 * goes away: with the status and the headers that went out, the body bytes,
 * and whether the body stopped before its end. In an app server, it reports the response that
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
	const server: Context<ServerEnv> = context;
	const reports = server.get("sentReports");
	if (reports != null) {
		reports.push(report);
		return;
	}
	// Why now: outside an app server, nothing reports later, so this counts the response as it is.
	const response = context.res;
	const body = reportedBody(context, response.headers, report);
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
	 * The response for an error that a header hook throws, as the app's
	 * `onError` gives it. It runs while `context.res` is cleared.
	 */
	fail: (error: unknown, context: Context<AppServerEnv>) => Response | Promise<Response>;
};

/**
 * Puts the response that `fail` gives for `error` in place of the response of
 * the request, and cancels the body that no one reads now.
 */
async function useErrorResponse(
	context: Context<AppServerEnv>,
	fail: Finish["fail"],
	error: unknown,
): Promise<void> {
	const { body } = context.res;
	// Why clear first: Hono's `c.text` copies each header of the response that the context holds.
	context.res = undefined;
	context.res = await fail(error, context);
	void body?.cancel().catch(ignore);
}

/**
 * Gives `reports` the response of the request. With no edge, it makes one new
 * response with `headers`, when the hooks made them, and a body that counts
 * its bytes.
 */
function reportResponse(
	context: Context<AppServerEnv>,
	reports: Finish["reports"],
	headers: Headers | undefined,
): void {
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
	// Why keep `headers`: Bun empties the headers of the response that it sends, but not this object.
	const body =
		report == null ? undefined : reportedBody(context, headers ?? response.headers, report);
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

/** Puts the error response for `error` in place, then runs the hooks from `from` on it. */
async function finishAfterError(
	context: Context<AppServerEnv>,
	finish: Finish,
	{ error, from }: { error: unknown; from: number },
): Promise<void> {
	await useErrorResponse(context, finish.fail, error);
	await finishFrom(context, finish, from);
}

/** Puts the error response for `error` in place, and gives it to the reports. */
async function reportErrorResponse(
	context: Context<AppServerEnv>,
	finish: Finish,
	error: unknown,
): Promise<void> {
	await useErrorResponse(context, finish.fail, error);
	reportResponse(context, finish.reports, undefined);
}

/** {@link finishResponse} from the hook at `from`, down to the first one. */
function finishFrom(
	context: Context<AppServerEnv>,
	finish: Finish,
	from: number,
): Promise<void> | undefined {
	const { hooks, reports, edge } = finish;
	const base = headerList(context.res.headers);
	// Why a copy with an edge: the edge compares the response that the listener gets with `base`.
	const head = edge == null ? base : [...base];
	const view = listView(head);
	for (let index = from; index >= 0; index -= 1) {
		try {
			hooks[index]?.(view);
		} catch (error) {
			return finishAfterError(context, finish, { error, from: index - 1 });
		}
	}
	if (edge != null) {
		edge.useHeaders({ base, headers: head });
		for (const report of reports) {
			edge.onSent(report);
		}
		return undefined;
	}
	if (hooks.length === 0) {
		reportResponse(context, reports, undefined);
		return undefined;
	}
	const headers = new Headers();
	try {
		for (let index = 0; index < head.length; index += 2) {
			headers.append(head[index] ?? "", head[index + 1] ?? "");
		}
	} catch (error) {
		// Why: a hook set a value that `Headers` rejects. The error response keeps its own headers.
		return reportErrorResponse(context, finish, error);
	}
	reportResponse(context, reports, headers);
	return undefined;
}

/**
 * Finishes the response of the request, after each stage. The server calls it
 * once, in the request's `requestContext()`.
 *
 * - It runs `hooks` on the head, in reverse order, so the hook of an inner
 *   stage runs first and an outer stage has the last word. When a hook
 *   throws, `fail` gives the response that takes the place of this one, and
 *   the hooks of the outer stages run on it, as when a stage throws.
 * - It gives `reports` the response, so each one runs when it ends.
 *
 * With `edge`, the head stays a list that the listener writes, so the server
 * copies no response. Else the server makes one new response with the head
 * and a body that counts its bytes. It gives a promise only when a hook
 * throws, so a response with no error waits for no microtask.
 *
 * @example
 * await next();
 * await finishResponse(context, { hooks, reports, edge, fail: (error, c) => onError(error, c) });
 */
export function finishResponse(
	context: Context<AppServerEnv>,
	finish: Finish,
): Promise<void> | undefined {
	return finishFrom(context, finish, finish.hooks.length - 1);
}
