import type { Context } from "hono";
import type { AppServerEnv, RequestContext, RequestStore } from "./types.js";

let store: RequestStore | undefined;

/** Sets the storage that {@link requestContext} reads. `createEntry` sets the host's. */
export function setRequestStore(next: RequestStore | undefined): void {
	store = next;
}

/** Runs `work` with `context` as the request that {@link requestContext} reads. */
export async function withRequestContext(
	context: Context<AppServerEnv>,
	work: () => Promise<void>,
): Promise<void> {
	return store == null ? work() : store.run(context, work);
}

/**
 * The request ID and logger of the request that runs. It gives `undefined`
 * outside a server request, such as in a prerender pass, or on a host with no
 * request storage.
 *
 * @example
 * export async function loader() {
 * 	requestContext()?.logger.info("loading the dashboard");
 * }
 */
export function requestContext(): RequestContext | undefined {
	const context = store?.get();
	if (context == null) {
		return undefined;
	}
	return { requestId: context.get("requestId"), logger: context.var.logger };
}
