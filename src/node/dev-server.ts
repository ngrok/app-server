import { IncomingMessage, ServerResponse } from "node:http";
import type { OutgoingHttpHeader, OutgoingHttpHeaders } from "node:http";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { MiddlewareHandler } from "hono";
import type { AppServerEnv, HeaderHook, ListenerBindings, ResponseHeaders } from "../core/types.js";
import { publicScriptHashes } from "./script-hashes.js";

/** A Connect middleware, such as `vite.middlewares`. */
export type NodeMiddleware = (
	request: IncomingMessage,
	response: ServerResponse,
	next: (error?: unknown) => void,
) => void;

/** What a `node:http` listener passes to the app with each request. */
export type NodeBindings = ListenerBindings & {
	/** Node's request. */
	incoming?: IncomingMessage;
	/** Node's response. */
	outgoing?: ServerResponse;
};

function isServerResponse(value: unknown): value is ServerResponse {
	return value instanceof ServerResponse;
}

/**
 * Makes `outgoing` run `hooks` before it sends its head, and returns the
 * function that undoes it. Why `writeHead`: Node calls it for each
 * response, also from `write` and `end`.
 */
function runHooksAtHead(outgoing: ServerResponse, hooks: readonly HeaderHook[]): () => void {
	const headers: ResponseHeaders = {
		get: (name) => {
			const value = outgoing.getHeader(name);
			return value == null ? null : String(value);
		},
		has: (name) => outgoing.hasHeader(name),
		set: (name, value) => {
			outgoing.setHeader(name, value);
		},
		append: (name, value) => {
			outgoing.appendHeader(name, value);
		},
		delete: (name) => {
			outgoing.removeHeader(name);
		},
	};
	const writeHead = outgoing.writeHead.bind(outgoing);
	outgoing.writeHead = (
		statusCode: number,
		reason?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
		values?: OutgoingHttpHeaders | OutgoingHttpHeader[],
	) => {
		const [message, given] = typeof reason === "string" ? [reason, values] : [undefined, reason];
		// Why: the hooks must see the headers that `writeHead` gets, such as the content type of a file.
		if (Array.isArray(given)) {
			// Why remove, then append: Node reads a flat `[name, value, …]` list so. A name replaces the old value and can repeat.
			const names = given.filter((_, index) => index % 2 === 0).map(String);
			for (const name of names) {
				outgoing.removeHeader(name);
			}
			for (const [index, name] of names.entries()) {
				const value = given[index * 2 + 1];
				if (value != null) {
					outgoing.appendHeader(name, typeof value === "number" ? String(value) : value);
				}
			}
		} else if (given != null) {
			for (const [name, value] of Object.entries(given)) {
				if (value != null) {
					outgoing.setHeader(name, value);
				}
			}
		}
		// Why reversed: in production, the hook of an inner stage runs first, so an outer stage has the last word.
		for (const hook of hooks.toReversed()) {
			hook(headers);
		}
		return message == null ? writeHead(statusCode) : writeHead(statusCode, message);
	};
	return () => {
		outgoing.writeHead = writeHead;
	};
}

/** Options for {@link devServerStage}. */
export type DevServerStageOptions = {
	/**
	 * The directory that the middleware serves as it is, and the URL base that
	 * it serves the directory at, such as Vite's `publicDir` and `base`. An HTML
	 * file from it gets the `contentSecurityPolicy` with the hashes of its
	 * inline scripts, as it does in production. Why a function: a Vite restart
	 * can change both.
	 */
	publicFiles?: () => { directory: string; base: string };
};

/** The script hashes of the public HTML file at `pathname`, or `undefined` when there is none. */
function publicFileHashes(
	{ directory, base }: { directory: string; base: string },
	pathname: string,
): string[] | undefined {
	const prefix = base.replace(/\/$/u, "");
	return pathname.startsWith(`${prefix}/`)
		? publicScriptHashes(directory, pathname.slice(prefix.length))
		: undefined;
}

/**
 * Runs a Connect middleware, such as Vite's, inside the pipeline. The
 * middleware answers or calls `next`. A request with no Node request and
 * response goes on.
 *
 * @example
 * entry.fetchDev(request, bindings, devServerStage(viteServer.middlewares, {
 *   publicFiles: () => ({ directory: viteServer.config.publicDir, base: viteServer.config.base }),
 * }));
 */
export function devServerStage(
	middleware: NodeMiddleware,
	{ publicFiles }: DevServerStageOptions = {},
): MiddlewareHandler<AppServerEnv> {
	return async (context, next) => {
		const { incoming, outgoing } = context.env;
		if (!(incoming instanceof IncomingMessage) || !isServerResponse(outgoing)) {
			return next();
		}
		const hashes =
			publicFiles == null
				? undefined
				: publicFileHashes(publicFiles(), new URL(context.req.url).pathname);
		const earlierHashes = context.get("documentScriptHashes");
		if (hashes != null) {
			context.set("documentScriptHashes", hashes);
		}
		// Why before the middleware: it sends the headers itself, so the headers the earlier stages
		// set, such as the request ID, must be on `outgoing` first.
		for (const [name, value] of context.res.headers) {
			outgoing.appendHeader(name, value);
		}
		const undoHooks = runHooksAtHead(outgoing, context.get("headerHooks") ?? []);
		const answered = await new Promise<boolean>((resolve, reject) => {
			const onFinish = () => {
				resolve(true);
			};
			outgoing.once("finish", onFinish);
			middleware(incoming, outgoing, (error) => {
				outgoing.off("finish", onFinish);
				// Why: the later stages answer, and each hook runs on their response.
				undoHooks();
				// Why: the middleware did not send the public file, so its hashes do not apply.
				if (hashes != null) {
					context.set("documentScriptHashes", earlierHashes);
				}
				if (error == null) {
					resolve(false);
				} else {
					reject(new Error("The dev server middleware failed", { cause: error }));
				}
			});
		});
		if (answered) {
			// Why a new response per request: the later stages set headers on it. The headers of
			// `RESPONSE_ALREADY_SENT` tell `@hono/node-server` to send nothing. The status and length
			// are the middleware's, for the access log.
			const headers = new Headers(RESPONSE_ALREADY_SENT.headers);
			const length = outgoing.getHeader("Content-Length");
			if (length != null) {
				headers.set("Content-Length", String(length));
			}
			return new Response(null, { status: outgoing.statusCode, headers });
		}
		return next();
	};
}
