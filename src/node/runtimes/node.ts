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
	let draining = false;
	const listener = requestListener(fetch, {
		trustForwardedProto: options.trustForwardedProto,
		isDraining: () => draining,
	});
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
				draining = true;
				// Why: `close()` closes only the connections that are idle now. With this timeout,
				// Node closes each other connection 1 ms after its last response ends.
				server.keepAliveTimeout = 1;
				server.keepAliveTimeoutBuffer = 0;
				let cut = false;
				const deadline = setTimeout(() => {
					cut = true;
					server.closeAllConnections();
				}, deadlineMs);
				server.close((error) => {
					clearTimeout(deadline);
					if (error != null) {
						reject(error);
					} else if (cut) {
						// Why a timer: Node emits `close` for each response that the deadline cut after
						// this callback. The access line of each one then comes before the stop settles.
						setTimeout(resolve, 0);
					} else {
						resolve();
					}
				});
			}),
	};
}
