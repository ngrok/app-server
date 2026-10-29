import { IncomingMessage, ServerResponse } from "node:http";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { MiddlewareHandler } from "hono";
import type { AppServerEnv, ListenerBindings } from "../core/types.js";

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
 * Runs a Connect middleware, such as Vite's, inside the pipeline. The
 * middleware answers or calls `next`. A request with no Node request and
 * response goes on.
 *
 * @example
 * entry.fetchDev(request, bindings, devServerStage(viteServer.middlewares));
 */
export function devServerStage(middleware: NodeMiddleware): MiddlewareHandler<AppServerEnv> {
	return async (context, next) => {
		const { incoming, outgoing } = context.env;
		if (!(incoming instanceof IncomingMessage) || !isServerResponse(outgoing)) {
			return next();
		}
		// Why before the middleware: it sends the headers itself, so the headers the earlier stages
		// set, such as the request ID, must be on `outgoing` first.
		for (const [name, value] of context.res.headers) {
			outgoing.appendHeader(name, value);
		}
		const answered = await new Promise<boolean>((resolve, reject) => {
			const onFinish = () => {
				resolve(true);
			};
			outgoing.once("finish", onFinish);
			middleware(incoming, outgoing, (error) => {
				outgoing.off("finish", onFinish);
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
