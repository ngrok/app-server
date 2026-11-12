import type { Context } from "hono";
import { hookSink, jsonSink, sinkLogger } from "./log.js";
import type {
	AppServerEnv,
	LogSink,
	RequestContext,
	RequestLogger,
	RequestStore,
} from "./types.js";

/**
 * Each store that a request ran in. Why a set: two entries in one process can
 * have two hosts, and each request uses the store of its own app.
 */
const stores = new Set<RequestStore>();

/** The {@link RequestContext} values of a request. */
export function requestContextValues(context: Context<AppServerEnv>): RequestContext {
	return {
		requestId: context.get("requestId"),
		logger: context.get("logger"),
		cspNonce: context.get("cspNonce"),
		clientAddress: context.get("clientAddress"),
	};
}

/** Runs `work` in `store` with `context` as the request that {@link requestContext} reads. */
export async function withRequestContext<Result>(
	store: RequestStore | undefined,
	context: Context<AppServerEnv>,
	work: () => Promise<Result>,
): Promise<Result> {
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
	const context = currentContext();
	return context == null ? undefined : requestContextValues(context);
}

/** The Hono context of the request that runs, else `undefined`. */
function currentContext(): Context<AppServerEnv> | undefined {
	for (const store of stores) {
		const context = store.get();
		if (context != null) {
			return context;
		}
	}
	return undefined;
}

/** The sink of the process. `createServer` sets it to its own sink, with its hooks. */
let processSink: LogSink = hookSink(jsonSink());

/** Sets the sink of the logger that {@link logger} gives outside a request. The last call wins. */
export function setProcessSink(sink: LogSink): void {
	processSink = sink;
}

/**
 * A logger that writes to the sink of the process at the time of each call.
 * Why: a value made before `createServer`, such as a context default, then
 * writes to the sink of the server.
 */
export const outsideLogger: RequestLogger = sinkLogger({
	log: (level, message, attributes) => {
		processSink.log(level, message, attributes);
	},
});

/**
 * The logger of the request that runs. Outside a request, such as at module
 * load or in a prerender pass, it gives a logger that writes to the sink and
 * the hooks of the last `createServer` call, else to `jsonSink()`.
 *
 * @example
 * import { logger } from "@ngrok/app-server";
 *
 * export async function loader() {
 * 	logger().info("loading the dashboard", { "usr.id": userId });
 * }
 */
export function logger(): RequestLogger {
	return currentContext()?.get("logger") ?? outsideLogger;
}
