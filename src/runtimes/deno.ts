import type { FetchHandler, StartedListener } from "../types.js";
import { listenerUrl, type ListenOptions } from "./listen-options.js";

/** The part of Deno's server that the listener uses. */
type DenoServer = {
	addr: { port: number };
	shutdown: () => Promise<void>;
};

/** The part of the `Deno` global that the listener uses. */
type DenoGlobal = {
	serve: (
		options: { port: number; hostname?: string; onListen: () => void },
		handler: (
			request: Request,
			info: { remoteAddr: { hostname: string } },
		) => Response | Promise<Response>,
	) => DenoServer;
};

/** Listens with `Deno.serve`. */
export async function listen(
	fetch: FetchHandler,
	options: ListenOptions,
): Promise<StartedListener> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `Deno` is a runtime global with no types in this package.
	const deno = Reflect.get(globalThis, "Deno") as DenoGlobal;
	const server = deno.serve(
		{
			port: options.port,
			...(options.hostname == null ? {} : { hostname: options.hostname }),
			// Why a no-op: the server logs its own startup line.
			onListen: () => {},
		},
		(request, info) => fetch(request, { remoteAddress: info.remoteAddr.hostname }),
	);
	return {
		url: listenerUrl(options.hostname, server.addr.port),
		stop: async ({ deadlineMs }) => {
			// Why a race: `shutdown()` waits for every open request, and Deno has no forced close.
			let deadline: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				server.shutdown(),
				new Promise<void>((resolve) => {
					deadline = setTimeout(resolve, deadlineMs);
				}),
			]);
			clearTimeout(deadline);
		},
	};
}
