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
	let copied = false;
	const write = (name: string, value: string | undefined, { append }: { append: boolean }) => {
		if (copied) {
			if (value == null) {
				context.res.headers.delete(name);
			} else if (append) {
				context.res.headers.append(name, value);
			} else {
				context.res.headers.set(name, value);
			}
			return;
		}
		// Why `context.header` once: it copies the response, so it works on immutable headers and
		// keeps the framework's object unchanged. It copies again on each call, so the later writes
		// go to the copy.
		context.header(name, value, { append });
		copied = true;
	};
	const headers: ResponseHeaders = {
		get: (name) => context.res.headers.get(name),
		has: (name) => context.res.headers.has(name),
		set: (name, value) => {
			write(name, value, { append: false });
		},
		append: (name, value) => {
			write(name, value, { append: true });
		},
		delete: (name) => {
			write(name, undefined, { append: false });
		},
	};
	hook(headers);
}
