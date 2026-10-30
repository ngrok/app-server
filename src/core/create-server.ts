import { Hono } from "hono";
import { errorAttributes, jsonSink, requestLogger } from "./log.js";
import { accessLog } from "./plugins/access-log.js";
import { bodyLimit } from "./plugins/body-limit.js";
import { privateDocuments } from "./plugins/private-documents.js";
import { redirects } from "./plugins/redirects.js";
import type { RedirectRule } from "./plugins/redirects.js";
import type { AccessLogOptions } from "./plugins/access-log.js";
import { requestId } from "./plugins/request-id.js";
import type { RequestIdOptions } from "./plugins/request-id.js";
import { assets, prerendered } from "./plugins/static.js";
import type { PrerenderedOptions } from "./plugins/static.js";
import { streamingCompress } from "./plugins/streaming-compress.js";
import { trailingSlash } from "./plugins/trailing-slash.js";
import type { TrailingSlash } from "./plugins/trailing-slash.js";
import { withRequestContext } from "./request-context.js";
import { abortShutdownSignal, markStopping, renewShutdownSignal } from "./shutdown.js";
import type {
	AppServerEnv,
	FetchHandler,
	FrameworkRuntime,
	Listener,
	LogSink,
	Plugin,
	RequestStore,
	SetupInfo,
} from "./types.js";

// Why a WeakMap: only this copy of the package reads an app's internals, through `createEntry`.
const appInternals = new WeakMap<AppServer, ServerInternals>();

/** A Hono app from {@link createServer}. Add routes to it before you export it. */
export type AppServer = Hono<AppServerEnv>;

/** A server that listens. */
export type RunningServer = {
	/** The URL of each listener. */
	urls: readonly string[];
	/**
	 * Marks the server as not ready, and waits for the shutdown delay. Then it
	 * aborts `shutdownSignal()` and runs each plugin's `onShutdown` while the
	 * listeners stop and drain open requests. Both stop at the deadline.
	 */
	shutdown: () => Promise<void>;
};

/** What `createEntry` calls on an app. */
export type ServerInternals = {
	logger: LogSink;
	/** Runs each plugin's `setup` once and adds the framework handler after the app's routes. */
	prepare: (info: SetupInfo) => Promise<void>;
	/**
	 * Starts the app's listeners, else `defaultListeners`, the host's. Call
	 * `prepare` first.
	 */
	listen: (
		framework: FrameworkRuntime,
		defaultListeners: readonly Listener[],
	) => Promise<RunningServer>;
	/** Runs each plugin's `onShutdown` once, and stops waiting for them at the shutdown deadline. */
	stopPlugins: () => Promise<void>;
	/** Sets the storage for `requestContext()` in this app's requests. `createEntry` sets the host's. */
	setRequestStore: (store: RequestStore | undefined) => void;
};

/** Why 10 MiB: a form or an avatar upload fits, and a body cannot fill the memory. */
const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024;

/** Options for {@link defaultPlugins}. */
export type DefaultPluginsOptions = {
	requestId?: RequestIdOptions;
	accessLog?: AccessLogOptions;
	prerendered?: PrerenderedOptions;
	/**
	 * Redirects from old URL paths to new URLs. They run before
	 * `trailingSlash`, so an old URL gets one redirect. See {@link redirects}.
	 */
	redirects?: readonly RedirectRule[];
	/**
	 * How a page URL ends. Set the same mode in the framework's router when it
	 * has one, else the redirects loop. See {@link trailingSlash}.
	 * @default "never"
	 */
	trailingSlash?: TrailingSlash;
	/**
	 * The largest request body, in bytes. A larger body gets a 413. `false`
	 * turns the limit off. See {@link bodyLimit}.
	 * @default 10485760 (10 MiB)
	 */
	bodyLimit?: number | false;
	/**
	 * Plugins that go after compression and before the static stages, so they
	 * see every response, prerendered pages included. `runtimeEnv` and
	 * `buildId` go here.
	 */
	beforeStatic?: readonly Plugin[];
};

/**
 * The default pipeline, in order: `requestId`, `accessLog`,
 * `streamingCompress`, `bodyLimit`, the `beforeStatic` plugins, `assets`,
 * `redirects` (when the option has rules), `trailingSlash`, `prerendered`,
 * and `privateDocuments`. It is a plain
 * array, so an app can filter it or splice into it.
 *
 * @example
 * createServer({ plugins: defaultPlugins({ accessLog: { redactQuery: false }, beforeStatic: [env] }) });
 */
export function defaultPlugins(options: DefaultPluginsOptions = {}): Plugin[] {
	const maxBytes = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	return [
		requestId(options.requestId),
		accessLog(options.accessLog),
		streamingCompress(),
		...(maxBytes === false ? [] : [bodyLimit({ maxBytes })]),
		...(options.beforeStatic ?? []),
		assets(),
		...(options.redirects == null || options.redirects.length === 0
			? []
			: [redirects(options.redirects)]),
		// Why after `assets`: in development, the dev server there answers Vite's paths, such as `/@vite/client`.
		trailingSlash({ mode: options.trailingSlash ?? "never" }),
		prerendered(options.prerendered),
		// Why last: it must see only the responses of the app's routes and the framework.
		privateDocuments(),
	];
}

/** Options for {@link createServer}. */
export type CreateServerOptions = {
	/** @default defaultPlugins() */
	plugins?: readonly Plugin[];
	/** @default jsonSink() */
	logger?: LogSink;
	/** @default the host's listeners, such as `[tcp()]` on the node host */
	listeners?: readonly Listener[];
	/**
	 * Read the request scheme from `X-Forwarded-Proto`. Set it only behind a
	 * proxy that overwrites that header, else a client can spoof it.
	 * @default false
	 */
	trustForwardedProto?: boolean;
	/**
	 * How many proxies in front of the server add the address they got a
	 * request from to `X-Forwarded-For`. With N, the client address is the
	 * Nth address from the right of that header. A header with fewer
	 * addresses gives its leftmost address. Set it only to the number of
	 * proxies that you run, else a client can spoof its address.
	 * @default 0, the address of the socket
	 */
	trustedProxyHops?: number;
	/**
	 * How long the listeners serve on after a stop signal, before the drain
	 * starts. During this time, the `health` plugin's readiness probe answers
	 * 503, so a load balancer stops sending requests first. The drain deadline
	 * starts after the delay.
	 * @default 0
	 */
	shutdownDelayMs?: number;
	/**
	 * How long open requests get to finish after the drain starts.
	 * @default 10000
	 */
	shutdownDeadlineMs?: number;
};

/**
 * The client address in an `X-Forwarded-For` header, with `hops` trusted
 * proxies, or `undefined` when the header has no address.
 */
function forwardedClient(header: string | undefined, hops: number): string | undefined {
	const addresses = (header ?? "")
		.split(",")
		.map((address) => address.trim())
		.filter((address) => address !== "");
	return addresses[Math.max(0, addresses.length - hops)];
}

/** Throws for a value that is not an integer of 0 or more, so a bad option stops startup. */
function checkCount(name: string, value: number): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be an integer of 0 or more, not ${value}.`);
	}
}

/** The request with the scheme from `X-Forwarded-Proto`, when that header holds one. */
function withForwardedProto(request: Request): Request {
	const proto = request.headers.get("X-Forwarded-Proto");
	if (proto !== "http" && proto !== "https") {
		return request;
	}
	const url = new URL(request.url);
	url.protocol = `${proto}:`;
	return new Request(url, request);
}

/**
 * Runs `step`, and rethrows a thrown value that is not an `Error` as one.
 * Hono sends only an `Error` to `onError`, and rethrows any other value.
 */
async function asError<Result>(step: () => Promise<Result>): Promise<Result> {
	try {
		return await step();
	} catch (error) {
		throw error instanceof Error
			? error
			: new Error(`A non-Error value was thrown: ${String(error)}`, { cause: error });
	}
}

/** Whether `work` settles before `ms` pass. */
async function settlesWithin(work: Promise<void>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const settled = await Promise.race([
		work.then(() => true),
		new Promise<boolean>((resolve) => {
			timer = setTimeout(resolve, ms, false);
		}),
	]);
	clearTimeout(timer);
	return settled;
}

/**
 * Builds an app server: a Hono app that runs the plugins in list order, then
 * the app's own routes, then the framework. It does not listen; the
 * `app-server` CLI starts it.
 *
 * @example
 * // server.ts
 * const app = createServer({ logger: slogSink, plugins: defaultPlugins({ beforeStatic: [env] }) });
 * app.get("/livez", (c) => c.text("ok"));
 * export default app;
 */
export function createServer({
	plugins = defaultPlugins(),
	logger = jsonSink(),
	listeners,
	trustForwardedProto = false,
	trustedProxyHops = 0,
	shutdownDelayMs = 0,
	shutdownDeadlineMs = 10_000,
}: CreateServerOptions = {}): AppServer {
	checkCount("trustedProxyHops", trustedProxyHops);
	checkCount("shutdownDelayMs", shutdownDelayMs);
	const app = new Hono<AppServerEnv>();
	let requestStore: RequestStore | undefined;
	if (trustForwardedProto) {
		// Why wrap `fetch`: every plugin and route, not only the framework, must see the trusted scheme.
		const dispatch = app.fetch;
		app.fetch = async (request, ...rest) => dispatch(withForwardedProto(request), ...rest);
	}
	app.use(async (context, next) => {
		context.set("logger", requestLogger(logger, context));
		const remoteAddress = context.env?.remoteAddress;
		context.set(
			"clientAddress",
			trustedProxyHops === 0
				? remoteAddress
				: (forwardedClient(context.req.header("X-Forwarded-For"), trustedProxyHops) ??
						remoteAddress),
		);
		await withRequestContext(requestStore, context, next);
		// Why cancel: Hono drops the body of a HEAD response without a cancel, so a stream would run on.
		if (context.req.method === "HEAD") {
			await context.res.body?.cancel();
		}
	});
	// Why `asError` at each step: a value that is not an `Error` becomes one where it is thrown,
	// so `onError` answers at once and each earlier plugin still sees the 500 after its `next`.
	for (const { middleware, etagPart } of plugins) {
		app.use(async (context, next) => {
			const part = etagPart?.();
			if (part != null) {
				context.set("etagParts", [...(context.get("etagParts") ?? []), part]);
			}
			return asError(async () => (middleware == null ? next() : middleware(context, next)));
		});
	}
	app.use(async (_, next) => asError(next));
	app.onError((error, context) => {
		// Why no `instanceof`: the app's routes can throw an `HTTPException` from another copy of Hono.
		if ("getResponse" in error && typeof error.getResponse === "function") {
			const response: unknown = error.getResponse();
			if (response instanceof Response) {
				return response;
			}
		}
		context.var.logger.error("unhandled error", errorAttributes(error));
		return context.text("Internal Server Error", 500);
	});

	let prepared: Promise<void> | undefined;
	let running: RunningServer | undefined;
	let stoppingPlugins: Promise<void> | undefined;
	const internals: ServerInternals = {
		logger,
		setRequestStore: (store) => {
			requestStore = store;
		},
		prepare: async (info) => {
			prepared ??= (async () => {
				for (const plugin of plugins) {
					await plugin.setup?.(info);
				}
				app.all("*", async (context) => context.env.framework.fetch(context.req.raw, context));
			})();
			return prepared;
		},
		listen: async (framework, defaultListeners) => {
			if (running != null) {
				throw new Error("This app server is already listening.");
			}
			renewShutdownSignal();
			let deadlinePassed = false;
			const fetch: FetchHandler = async (request, bindings) => {
				const response = await app.fetch(request, { ...bindings, framework });
				// Why: after the drain deadline, the listener closed the connection, so no one reads this
				// body. A cancel stops its producer, which can otherwise keep the process alive.
				if (deadlinePassed) {
					await response.body?.cancel();
				}
				return response;
			};
			const starts = await Promise.allSettled(
				(listeners ?? defaultListeners).map(async (listener) => listener.start(fetch)),
			);
			const started = starts.flatMap((start) =>
				start.status === "fulfilled" ? [start.value] : [],
			);
			const failed = starts.find((start) => start.status === "rejected");
			if (failed != null) {
				// Why stop the others: the caller gets no handle to stop them.
				await Promise.all(started.map(async (listener) => listener.stop({ deadlineMs: 0 })));
				throw failed.reason;
			}
			const urls = started.map((listener) => listener.url);
			logger.log("info", "listening", { "app_server.urls": urls });
			let stopping: Promise<void> | undefined;
			running = {
				urls,
				shutdown: async () => {
					stopping ??= (async () => {
						markStopping();
						if (shutdownDelayMs > 0) {
							logger.log("info", "waiting before the drain", {
								"app_server.delay_ms": shutdownDelayMs,
							});
							await new Promise((resolve) => {
								setTimeout(resolve, shutdownDelayMs);
							});
						}
						logger.log("info", "draining", { "app_server.deadline_ms": shutdownDeadlineMs });
						abortShutdownSignal();
						const deadline = setTimeout(() => {
							deadlinePassed = true;
						}, shutdownDeadlineMs);
						// Why at the same time: a plugin that hangs must not keep the listeners open.
						// Why settle all: the process exits after shutdown, so one failed stop must not cut
						// the other stops short.
						const results = await Promise.allSettled([
							internals.stopPlugins(),
							...started.map(async (listener) => listener.stop({ deadlineMs: shutdownDeadlineMs })),
						]);
						clearTimeout(deadline);
						const rejected = results.find((result) => result.status === "rejected");
						if (rejected != null) {
							throw rejected.reason;
						}
						logger.log("info", "stopped", {});
					})();
					return stopping;
				},
			};
			return running;
		},
		stopPlugins: async () => {
			stoppingPlugins ??= (async () => {
				const hooks = (async () => {
					const results = await Promise.allSettled(
						plugins.map(async (plugin) => plugin.onShutdown?.()),
					);
					for (const result of results) {
						if (result.status === "rejected") {
							logger.log("error", "plugin shutdown failed", errorAttributes(result.reason));
						}
					}
				})();
				if (!(await settlesWithin(hooks, shutdownDeadlineMs))) {
					logger.log("warn", "plugin shutdown passed the deadline", {
						"app_server.deadline_ms": shutdownDeadlineMs,
					});
				}
			})();
			return stoppingPlugins;
		},
	};
	appInternals.set(app, internals);
	return app;
}

/** The internals of an app from {@link createServer} of this copy of the package, else `undefined`. */
export function serverInternals(app: AppServer): ServerInternals | undefined {
	return appInternals.get(app);
}
