import type { Context } from "hono";
import { hookSink, jsonSink, sinkLogger } from "./log.js";
import type { ShutdownState } from "./shutdown.js";
import type {
	AppServerEnv,
	LogSink,
	RequestContext,
	RequestLogger,
	RequestScope,
	RequestStore,
	ServerEnv,
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

/** Runs `work` in `store` with `scope` as the request that {@link requestContext} reads. */
export function withRequestContext<Result>(
	store: RequestStore | undefined,
	scope: RequestScope,
	work: () => Result,
): Result {
	if (store == null) {
		return work();
	}
	stores.add(store);
	return store.run(scope, work);
}

/**
 * The values of a request whose response is sent, with the fields of its log
 * lines and without its Hono context. Why a logger that the first read makes:
 * a timer that a request leaves keeps these values until it fires, and few of
 * those requests log again.
 */
class SentValues implements RequestContext {
	public readonly requestId: string | undefined;
	public readonly cspNonce: string | undefined;
	public readonly clientAddress: string | undefined;
	/** The stop state of the app server of the request, for {@link currentShutdown}. */
	public readonly shutdown: ShutdownState | undefined;
	readonly #sink: LogSink;
	readonly #method: string;
	readonly #path: string;
	readonly #logAttributes: Readonly<Record<string, unknown>> | undefined;
	#logger: RequestLogger | undefined;

	/** `made` is the logger that the server made for the request, and `sink` is where it writes. */
	public constructor(context: Context<ServerEnv>, sink: LogSink, made: RequestLogger) {
		this.requestId = context.get("requestId");
		this.cspNonce = context.get("cspNonce");
		this.clientAddress = context.get("clientAddress");
		this.shutdown = context.get("shutdown");
		this.#sink = sink;
		this.#method = context.req.method;
		this.#path = context.req.path;
		this.#logAttributes = context.get("logAttributes");
		const current = context.get("logger");
		// Why not `made`: it reads the context for each line. A logger that the app set stays.
		this.#logger = current === made ? undefined : current;
	}

	/** A logger whose lines carry the fields that the request's logger gave when the response ended. */
	public get logger(): RequestLogger {
		if (this.#logger == null) {
			const fields = {
				"http.request_id": this.requestId,
				"http.method": this.#method,
				"http.url_details.path": this.#path,
				...this.#logAttributes,
			};
			// Why `fields` two times: the first copy gives each key its place, and the second makes a
			// request field win over a caller's field of the same name.
			this.#logger = sinkLogger(this.#sink, (attributes) => ({
				...fields,
				...attributes,
				...fields,
			}));
		}
		return this.#logger;
	}
}

/**
 * Puts the values of the request in `scope`, in place of its Hono context.
 * `made` is the logger that the server made for the request, and `sink` is
 * where it writes. Why: a timer that the request leaves keeps the scope until
 * it fires. The context would keep the request, the response, and each hook
 * with it.
 */
export function releaseContext(scope: RequestScope, sink: LogSink, made: RequestLogger): void {
	if (scope.context != null) {
		scope.values = new SentValues(scope.context, sink, made);
		scope.context = undefined;
	}
}

/**
 * The request ID, logger, CSP nonce, and client address of the request that
 * runs. Work that the request started, such as a timer, gets the same values
 * after the response is sent. It gives `undefined` outside a server request,
 * such as in a prerender pass, or on a host with no request storage. To log
 * there too, use {@link logger}.
 *
 * @example
 * export async function loader() {
 * 	const requestId = requestContext()?.requestId;
 * }
 */
export function requestContext(): RequestContext | undefined {
	const scope = currentScope();
	if (scope?.context != null) {
		return requestContextValues(scope.context);
	}
	const values = scope?.values;
	// Why a copy: the values of a sent response give their logger through a getter, which a spread
	// of the object does not read.
	return values == null
		? undefined
		: {
				requestId: values.requestId,
				logger: values.logger,
				cspNonce: values.cspNonce,
				clientAddress: values.clientAddress,
			};
}

/** The scope of the request that runs, else `undefined`. */
function currentScope(): RequestScope | undefined {
	for (const store of stores) {
		const scope = store.get();
		if (scope != null) {
			return scope;
		}
	}
	return undefined;
}

/**
 * The stop state of the app server of the request that runs, also in work
 * that the request left after its response. It gives `undefined` outside a
 * server request and on a host with no request storage.
 */
export function currentShutdown(): ShutdownState | undefined {
	const scope = currentScope();
	const context: Context<ServerEnv> | undefined = scope?.context;
	if (context != null) {
		return context.get("shutdown");
	}
	return scope?.values instanceof SentValues ? scope.values.shutdown : undefined;
}

/**
 * Sends `request` through the framework in the same process, and gives the
 * framework's response. Use it in a plugin, a route, or a loader to get the
 * answer of another of the app's routes, such as the markdown of a page,
 * with no network round trip and no table of the app's routes.
 *
 * The request skips each plugin and each Hono route of the app: it gets no
 * access log line, no compression, no auth plugin, and no prerendered file.
 * The framework runs its route middleware. The request shares the request ID,
 * the logger, and the client address of the request that runs. Build the URL
 * from the URL of that request, and copy each header that the route needs,
 * such as `Cookie`.
 *
 * It throws outside a request of the app server, such as in a prerender pass
 * or after the response is sent, and on a host with no request storage.
 *
 * @example
 * export async function loader({ request }: Route.LoaderArgs) {
 * 	const twin = await appFetch(new Request(new URL("/docs/button.md", request.url)));
 * }
 */
export async function appFetch(request: Request): Promise<Response> {
	const context: Context<ServerEnv> | undefined = currentScope()?.context;
	if (context == null) {
		throw new Error(
			"appFetch() runs only while the app server answers a request, on a host with request storage, such as node or vercel.",
		);
	}
	const routePattern = context.get("routePattern");
	try {
		return await context.env.framework.fetch(request, context);
	} finally {
		// Why: the framework sets the route pattern of the request that it renders, and the access log
		// line of the request that runs must keep its own.
		context.set("routePattern", routePattern);
	}
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
	log: ({ level, message, attributes }) => {
		processSink.log({ level, message, attributes });
	},
});

/**
 * The logger of the request that runs. Work that the request started, such as
 * a timer, gets a logger after the response is sent whose lines carry the
 * fields that the request had then. Outside a request, such as at module
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
	const scope = currentScope();
	return scope?.context?.get("logger") ?? scope?.values?.logger ?? outsideLogger;
}
