import type { FetchHandler, StartedListener } from "../types.js";
import { listenerUrl } from "./listen-options.js";
import type { ListenOptions } from "./listen-options.js";

/** The part of Bun's server that the listener uses. */
type BunServer = {
	port: number;
	requestIP: (request: Request) => { address: string } | null;
	stop: (closeActiveConnections?: boolean) => Promise<void>;
};

/** The part of the `Bun` global that the listener uses. */
type BunGlobal = {
	serve: (options: {
		port: number;
		hostname?: string;
		idleTimeout: number;
		fetch: (request: Request, server: BunServer) => Response | Promise<Response>;
	}) => BunServer;
};

/** Bun's largest `idleTimeout`, in seconds. */
const BUN_MAX_IDLE_TIMEOUT_S = 255;

/** Listens with `Bun.serve`. */
export async function listen(
	fetch: FetchHandler,
	options: ListenOptions,
): Promise<StartedListener> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `Bun` is a runtime global with no types in this package.
	const bun = Reflect.get(globalThis, "Bun") as BunGlobal;
	const server = bun.serve({
		port: options.port,
		...(options.hostname == null ? {} : { hostname: options.hostname }),
		// Why: Bun's 10 s default also closes a quiet event stream.
		idleTimeout: Math.min(BUN_MAX_IDLE_TIMEOUT_S, Math.ceil(options.idleTimeoutMs / 1_000)),
		fetch: async (request, bunServer) =>
			fetch(request, { remoteAddress: bunServer.requestIP(request)?.address }),
	});
	return {
		url: listenerUrl(options.hostname, server.port),
		stop: async ({ deadlineMs }) => {
			let deadline: ReturnType<typeof setTimeout> | undefined;
			const deadlinePassed = new Promise<void>((resolve) => {
				deadline = setTimeout(() => {
					void server.stop(true);
					resolve();
				}, deadlineMs);
			});
			// Why a race: on Bun 1.3, a response body that stays open keeps both stop promises
			// pending, and `stop(true)` leaves its connection open. The exit after shutdown closes it.
			await Promise.race([server.stop(), deadlinePassed]);
			clearTimeout(deadline);
		},
	};
}
