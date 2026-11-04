import { createServer } from "node:http";
import type { FetchHandler, StartedListener } from "../../core/types.js";
import { requestListener } from "../response-writer.js";
import { listenerUrl } from "./listen-options.js";
import type { ListenOptions } from "./listen-options.js";

/** Listens with `node:http`, and writes each response with the node response writer. */
export async function listen(
	fetch: FetchHandler,
	options: ListenOptions,
): Promise<StartedListener> {
	const listener = requestListener(fetch);
	const server = createServer(
		{
			keepAliveTimeout: options.idleTimeoutMs,
			// Why above the keep-alive timeout: Node closes a socket that is between requests when its
			// headers timer runs out first.
			headersTimeout: options.idleTimeoutMs + 1_000,
		},
		(incoming, outgoing) => {
			void listener(incoming, outgoing);
		},
	);
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
		stop: async ({ deadlineMs }) =>
			new Promise<void>((resolve, reject) => {
				const deadline = setTimeout(() => {
					server.closeAllConnections();
				}, deadlineMs);
				server.close((error) => {
					clearTimeout(deadline);
					if (error == null) {
						resolve();
					} else {
						reject(error);
					}
				});
				server.closeIdleConnections();
			}),
	};
}
