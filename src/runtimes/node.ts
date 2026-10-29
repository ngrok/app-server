import { IncomingMessage, ServerResponse } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import type { FetchHandler, StartedListener } from "../types.js";
import { listenerUrl, type ListenOptions } from "./listen-options.js";

/** Listens with `node:http` through `@hono/node-server`. */
export async function listen(
	fetch: FetchHandler,
	options: ListenOptions,
): Promise<StartedListener> {
	const server = createAdaptorServer({
		fetch: (request, { incoming, outgoing }) =>
			fetch(request, {
				remoteAddress: incoming.socket.remoteAddress,
				...(incoming instanceof IncomingMessage && outgoing instanceof ServerResponse
					? { incoming, outgoing }
					: {}),
			}),
		serverOptions: {
			keepAliveTimeout: options.idleTimeoutMs,
			// Why above the keep-alive timeout: Node closes a socket that is between requests when its
			// headers timer runs out first.
			headersTimeout: options.idleTimeoutMs + 1_000,
		},
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.hostname, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address != null ? address.port : options.port;
	return {
		url: listenerUrl(options.hostname, port),
		stop: ({ deadlineMs }) =>
			new Promise<void>((resolve, reject) => {
				const deadline = setTimeout(() => {
					if ("closeAllConnections" in server) {
						server.closeAllConnections();
					}
				}, deadlineMs);
				server.close((error) => {
					clearTimeout(deadline);
					if (error == null) {
						resolve();
					} else {
						reject(error);
					}
				});
				if ("closeIdleConnections" in server) {
					server.closeIdleConnections();
				}
			}),
	};
}
