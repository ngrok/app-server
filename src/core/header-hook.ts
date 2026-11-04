import type { Context, Next } from "hono";
import type { AppServerEnv, HeaderHook, ResponseHeaders } from "./types.js";

/**
 * The response that each request made, so a later write can change it in
 * place: a copy from {@link writableHeaders}, or a response from
 * {@link replaceResponse}. Why by request: an app can send a response of an
 * earlier request again, and this request must not change it.
 */
const owned = new WeakMap<Context<AppServerEnv>, Response>();

/**
 * Makes `response` the response of the request. It must be a new object,
 * such as `new Response(body, context.res)`, so that later writes change it
 * in place.
 *
 * Why clear first: Hono's setter copies the new response and sets each
 * header of the old one, such as its length, on it again.
 *
 * @example
 * replaceResponse(context, new Response(gzip(context.res.body), context.res));
 */
export function replaceResponse(context: Context<AppServerEnv>, response: Response): void {
	context.res = undefined;
	context.res = response;
	owned.set(context, response);
}

/**
 * The headers of `context.res`, to change after the later stages. The first
 * call for a response copies it, and later calls give the same copy.
 *
 * Why a copy: the response can have immutable headers, such as one from
 * `fetch()`, or be an object that the app sends again. Why one copy:
 * `context.header` copies the whole response on each call.
 *
 * @example
 * await next();
 * writableHeaders(context).set("Vary", "Accept-Encoding");
 */
export function writableHeaders(context: Context<AppServerEnv>): Headers {
	if (owned.get(context) !== context.res) {
		replaceResponse(context, new Response(context.res.body, context.res));
	}
	return context.res.headers;
}

/** A view of the headers of `context.res` that copies the response at the first change. */
function responseHeaders(context: Context<AppServerEnv>): ResponseHeaders {
	return {
		get: (name) => context.res.headers.get(name),
		has: (name) => context.res.headers.has(name),
		set: (name, value) => {
			writableHeaders(context).set(name, value);
		},
		append: (name, value) => {
			writableHeaders(context).append(name, value);
		},
		delete: (name) => {
			// Why check first: the first write copies the response, and a missing header needs no copy.
			if (context.res.headers.has(name)) {
				writableHeaders(context).delete(name);
			}
		},
	};
}

/**
 * Runs `hook` on the response headers after the later stages. In an app
 * server, the hook changes the head once, where the response leaves, so the
 * response needs no copy. That run comes after the code that each stage runs
 * after its `next()`, so a stage can decide there what its hook does. A hook
 * that throws gives a 500. See {@link HeaderHook} for the order of the hooks
 * and the views that also run them.
 *
 * @example
 * const frameOptions: Plugin = {
 * 	name: "frame-options",
 * 	middleware: async (c, next) =>
 * 		withHeaderHook(c, next, (response) => {
 * 			response.set("X-Frame-Options", "DENY");
 * 		}),
 * };
 */
export async function withHeaderHook(
	context: Context<AppServerEnv>,
	next: Next,
	hook: HeaderHook,
): Promise<void> {
	const hooks = context.get("headerHooks");
	// Why: outside an app server, such as in a plain Hono app, nothing runs the hook later.
	if (hooks == null) {
		await next();
		hook(responseHeaders(context));
		return;
	}
	hooks.push(hook);
	await next();
}

/**
 * The index of the lowercase `name` in a flat `[name, value, …]` header list, or -1.
 *
 * @example
 * headerIndex(["content-type", "text/html", "vary", "Accept"], "vary"); // => 2
 */
export function headerIndex(head: readonly string[], name: string): number {
	for (let index = 0; index < head.length; index += 2) {
		if (head[index] === name) {
			return index;
		}
	}
	return -1;
}

/**
 * The flat `[name, value, …]` list of `headers`, with lowercase names.
 *
 * @example
 * headerList(new Headers({ "Content-Type": "text/html" })); // => ["content-type", "text/html"]
 */
export function headerList(headers: Headers): string[] {
	const head: string[] = [];
	for (const [name, value] of headers) {
		head.push(name, value);
	}
	return head;
}

/**
 * A view of a flat `[name, value, …]` header list with lowercase names, for
 * the header hooks. It reads and changes the list as `Headers` does.
 */
export function listView(head: string[]): ResponseHeaders {
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
 * A view of `headers` after the header hook of each stage that the request
 * passed, in the order that the server runs them. Why: a stage that picks a
 * body by a header, such as `Cache-Control: no-transform`, must see the value
 * that a hook sets where the response leaves. So a hook can run more than
 * once. Why a view: the hooks change only the view, so `headers` needs no
 * copy.
 *
 * @example
 * forbidsTransform(hookedHeaders(context, headers).get("Cache-Control"));
 */
export function hookedHeaders(context: Context<AppServerEnv>, headers: Headers): ResponseHeaders {
	const view = listView(headerList(headers));
	const hooks = context.get("headerHooks") ?? [];
	// Why reversed: the hook of an inner stage runs first, so an outer stage has the last word.
	for (let index = hooks.length - 1; index >= 0; index -= 1) {
		try {
			hooks[index]?.(view);
		} catch {
			// Why drop it: the run where the response leaves answers the error, and logs it once. A hook
			// can also need state that its stage sets after `next()`, which a view can come before.
		}
	}
	return view;
}
