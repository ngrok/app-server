import type { Context } from "hono";
import type { AppServerEnv, RequestContext, RequestStore } from "./types.js";

/**
 * Each store that a request ran in. Why a set: two entries in one process can
 * have two hosts, and each request uses the store of its own app.
 */
const stores = new Set<RequestStore>();

/** The {@link RequestContext} values of a request. */
export function requestContextValues(context: Context<AppServerEnv>): RequestContext {
	return {
		requestId: context.get("requestId"),
		logger: context.var.logger,
		cspNonce: context.get("cspNonce"),
		clientAddress: context.get("clientAddress"),
	};
}

/** Runs `work` in `store` with `context` as the request that {@link requestContext} reads. */
export async function withRequestContext(
	store: RequestStore | undefined,
	context: Context<AppServerEnv>,
	work: () => Promise<void>,
): Promise<void> {
	if (store == null) {
		return work();
	}
	stores.add(store);
	return store.run(context, work);
}

/**
 * The request ID, logger, and CSP nonce of the request that runs. It gives `undefined`
 * outside a server request, such as in a prerender pass, or on a host with no
 * request storage.
 *
 * @example
 * export async function loader() {
 * 	requestContext()?.logger.info("loading the dashboard");
 * }
 */
export function requestContext(): RequestContext | undefined {
	for (const store of stores) {
		const context = store.get();
		if (context != null) {
			return requestContextValues(context);
		}
	}
	return undefined;
}
