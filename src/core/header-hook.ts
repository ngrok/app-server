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
 * server, the hook changes the head once, where the response leaves, after
 * the code that each stage runs after its `next()`. So a stage can decide
 * after its `next()` what its hook does, and the response needs no copy. A
 * hook that throws gives a 500. See {@link HeaderHook} for the order of the
 * hooks and the views that also run them.
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
	const changes = new Map<string, string | null>();
	const get = (name: string) => {
		const lower = name.toLowerCase();
		return changes.has(lower) ? (changes.get(lower) ?? null) : headers.get(lower);
	};
	const view: ResponseHeaders = {
		get,
		has: (name) => get(name) != null,
		set: (name, value) => {
			changes.set(name.toLowerCase(), value);
		},
		append: (name, value) => {
			const current = get(name);
			changes.set(name.toLowerCase(), current == null ? value : `${current}, ${value}`);
		},
		delete: (name) => {
			changes.set(name.toLowerCase(), null);
		},
	};
	const hooks = context.get("headerHooks") ?? [];
	// Why reversed: the hook of an inner stage runs first, so an outer stage has the last word.
	for (let index = hooks.length - 1; index >= 0; index -= 1) {
		hooks[index]?.(view);
	}
	return view;
}
