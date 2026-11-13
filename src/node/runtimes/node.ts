import { createServer } from "node:http";
import type { FetchHandler, StartedListener } from "../../core/types.js";
import { requestListener } from "../response-writer.js";
import { listenerUrl } from "./listen-options.js";
import type { ListenOptions } from "./listen-options.js";

/** Node's default `requestTimeout`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/** Listens with `node:http`, and writes each response with the node response writer. */
export async function listen(
	fetch: FetchHandler,
	options: ListenOptions,
): Promise<StartedListener> {
	const listener = requestListener(fetch, { trustForwardedProto: options.trustForwardedProto });
	// Why above the idle timeout: the headers timer runs on a new connection until its first
	// request comes, and a proxy can open a connection before it has a request for it.
	const headersTimeout = options.idleTimeoutMs + 1_000;
	const server = createServer(
		{
			keepAliveTimeout: options.idleTimeoutMs,
			headersTimeout,
			// Why: Node refuses a `headersTimeout` above the `requestTimeout`.
			requestTimeout: Math.max(DEFAULT_REQUEST_TIMEOUT_MS, headersTimeout),
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
