import type { FetchHandler, StartedListener } from "../../core/types.js";
import { listenerUrl } from "./listen-options.js";
import type { ListenOptions } from "./listen-options.js";

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

/** Wraps a response body so the listener can end it at the deadline. `open` holds its closer while the body is open. */
function closableResponse(response: Response, open: Set<() => void>): Response {
	if (response.body == null) {
		return response;
	}
	const reader = response.body.getReader();
	let force: () => void;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			force = () => {
				open.delete(force);
				controller.error(new Error("The shutdown deadline passed."));
				void reader.cancel();
			};
			open.add(force);
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					open.delete(force);
					controller.close();
				} else {
					controller.enqueue(value);
				}
			} catch (error) {
				open.delete(force);
				throw error;
			}
		},
		async cancel(reason) {
			open.delete(force);
			return reader.cancel(reason);
		},
	});
	return new Response(body, response);
}

/** Listens with `Deno.serve`. */
export async function listen(
	fetch: FetchHandler,
	options: ListenOptions,
): Promise<StartedListener> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `Deno` is a runtime global with no types in this package.
	const deno = Reflect.get(globalThis, "Deno") as DenoGlobal;
	// Why: Deno has no forced close, and `shutdown()` waits for each open request. At the
	// deadline, the listener answers each pending request with a 503 and ends each open body.
	const open = new Set<() => void>();
	const server = deno.serve(
		{
			port: options.port,
			...(options.hostname == null ? {} : { hostname: options.hostname }),
			// Why a no-op: the server logs its own startup line.
			onListen: () => {},
		},
		async (request, info) => {
			const forced = Promise.withResolvers<Response>();
			const force = () => {
				open.delete(force);
				forced.resolve(new Response(null, { status: 503 }));
			};
			open.add(force);
			const answer = (async () => {
				try {
					return closableResponse(
						await fetch(request, { remoteAddress: info.remoteAddr.hostname }),
						open,
					);
				} finally {
					open.delete(force);
				}
			})();
			return Promise.race([answer, forced.promise]);
		},
	);
	return {
		url: listenerUrl(options.hostname, server.addr.port),
		stop: async ({ deadlineMs }) => {
			const deadline = setTimeout(() => {
				for (const force of open) {
					force();
				}
			}, deadlineMs);
			await server.shutdown();
			clearTimeout(deadline);
		},
	};
}
