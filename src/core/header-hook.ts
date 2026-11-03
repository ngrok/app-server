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

/**
 * Runs `hook` on the response headers after the later stages. A dev server
 * middleware that sends its own response runs it too, before it sends the
 * head, so each response gets the same headers in development and in
 * production.
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
	context.set("headerHooks", [...(context.get("headerHooks") ?? []), hook]);
	await next();
	const headers: ResponseHeaders = {
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
	hook(headers);
}
