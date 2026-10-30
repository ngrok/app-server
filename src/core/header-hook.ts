import type { Context, Next } from "hono";
import type { AppServerEnv, HeaderHook, ResponseHeaders } from "./types.js";

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
		// Why `context.header`: it also works on a framework response with immutable headers.
		set: (name, value) => {
			context.header(name, value);
		},
		append: (name, value) => {
			context.header(name, value, { append: true });
		},
	};
	hook(headers);
}
