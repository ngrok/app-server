import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { ErrorHandler, HTTPResponseError } from "hono/types";
import { asError, hookSink, jsonSink, requestLogger } from "./log.js";
import { accessLog } from "./plugins/access-log.js";
import type { AccessLogOptions } from "./plugins/access-log.js";
import { bodyLimit } from "./plugins/body-limit.js";
import { buildId } from "./plugins/build-id.js";
import type { BuildIdOptions } from "./plugins/build-id.js";
import { health } from "./plugins/health.js";
import type { HealthOptions } from "./plugins/health.js";
import { noindex } from "./plugins/noindex.js";
import type { NoindexOptions } from "./plugins/noindex.js";
import { privateDocuments } from "./plugins/private-documents.js";
import { redirects } from "./plugins/redirects.js";
import type { RedirectRule } from "./plugins/redirects.js";
import { contentSecurityPolicy, securityHeaders } from "./plugins/security-headers.js";
import type {
	ContentSecurityPolicyOptions,
	SecurityHeadersOptions,
} from "./plugins/security-headers.js";
import { requestId } from "./plugins/request-id.js";
import type { RequestIdOptions } from "./plugins/request-id.js";
import type { RuntimeEnv } from "./plugins/runtime-env.js";
import { assets, prerendered } from "./plugins/static.js";
import type { PrerenderedOptions } from "./plugins/static.js";
import { streamingCompress } from "./plugins/streaming-compress.js";
import { trailingSlash } from "./plugins/trailing-slash.js";
import type { TrailingSlash } from "./plugins/trailing-slash.js";
import { checkOptionPlugins, presenceHeadersOf } from "./plugin-options.js";
import { setProcessSink, withRequestContext } from "./request-context.js";
import { finishResponse } from "./response-edge.js";
import { abortShutdownSignal, markStopping, renewShutdownSignal } from "./shutdown.js";
import type {
	AppServerEnv,
	FetchHandler,
	FrameworkRuntime,
	HeaderHook,
	Listener,
	LogOptions,
	LogSink,
	Plugin,
	RequestStore,
	SentResponse,
	SetupInfo,
} from "./types.js";

/** The response for `error`, as `onError` gives it for a stage that throws. */
function answerError(error: Error | HTTPResponseError, context: Context<AppServerEnv>): Response {
	// Why no `instanceof`: the app's routes can throw an `HTTPException` from another copy of Hono.
	if ("getResponse" in error && typeof error.getResponse === "function") {
		const response: unknown = error.getResponse();
		if (response instanceof Response) {
			return response;
		}
	}
	context.get("logger").error("unhandled error", { error });
	return context.text("Internal Server Error", 500);
}

/**
 * The app's `onError` handler, with a 500 for an error that `handler` returns
 * no `Response` for. Why: Hono turns a falsy response into an empty 200, so
 * such a handler would answer each of those errors with a 200.
 */
function checkedOnError(handler: ErrorHandler<AppServerEnv>): ErrorHandler<AppServerEnv> {
	return async (error, context) => {
		// Why the cast: the type says `Response`, but a handler in JavaScript can return each value.
		const answer = (await handler(error, context)) as Response | undefined;
		if (answer) {
			return answer;
		}
		return answerError(
			new TypeError(
				"The app's onError returned no Response. It must return a Response for each error.",
				{ cause: error },
			),
			context,
		);
	};
}

/**
 * Throws for an entry of `plugins` that is not an object, so a wrong plugin
 * list stops startup. Why: a function has no `middleware`, so the server
 * would start and never run it. Why `unknown`: the `Plugin` type rejects
 * these values, but a build can skip the type check, as Vite's does.
 */
function checkPluginObjects(plugins: readonly unknown[]): void {
	for (const [index, plugin] of plugins.entries()) {
		if (typeof plugin === "function") {
			const value = plugin.name === "" ? "a function" : `the function ${plugin.name}`;
			throw new TypeError(
				`plugins[${index}] is ${value}, not a plugin. Call a plugin factory, such as requestId(). Put a Hono middleware in a plugin, such as { name: "auth", middleware: basicAuth() }.`,
			);
		}
		if (typeof plugin !== "object" || plugin == null) {
			throw new TypeError(
				`plugins[${index}] is ${String(plugin)}, not a plugin. Remove it. To add a plugin on a condition, spread a list: ...(condition ? [plugin] : []).`,
			);
		}
	}
}

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
	/** The request headers whose presence alone changes the answer of a plugin. See `presenceHeaders`. */
	presenceHeaders: readonly string[];
	/** Runs each plugin's `setup` once and adds the framework handler after the app's routes. */
	prepare: (info: SetupInfo) => Promise<void>;
	/**
	 * Starts the app's listeners, else `defaultListeners`, the host's. Call
	 * `prepare` first. Throws when neither has a listener.
	 */
	listen: (
		framework: FrameworkRuntime,
		defaultListeners: readonly Listener[] | undefined,
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
	/**
	 * The options of the liveness and readiness probes. `false` turns them
	 * off, such as for an app with its own `/livez` route. See {@link health}.
	 * @default {}
	 */
	health?: HealthOptions | false;
	/**
	 * The options of the request ID of each request. See {@link requestId}.
	 * @default {}
	 */
	requestId?: RequestIdOptions;
	/**
	 * The options of the log line of each request. See {@link accessLog}.
	 * @default {}
	 */
	accessLog?: AccessLogOptions;
	/**
	 * The options of the files of the client build, such as `headers`, `skip`,
	 * and `markdownTwins`. See {@link prerendered}.
	 * @default {}
	 */
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
	 * The options of the security headers. `false` turns them off. See
	 * {@link securityHeaders}.
	 * @default {}
	 */
	securityHeaders?: SecurityHeadersOptions | false;
	/**
	 * Sets `X-Robots-Tag: noindex, nofollow` on each response, such as on a
	 * preview deploy. The options decide for each request. See {@link noindex}.
	 * @default false
	 */
	noindex?: boolean | NoindexOptions;
	/**
	 * The options of the build ID on each document and data response. `false`
	 * turns it off. See {@link buildId}.
	 * @default {}, with the ID that the `appServer` Vite plugin derives from the client build
	 */
	buildId?: BuildIdOptions | false;
	/**
	 * The options of the `Content-Security-Policy` of each HTML document. It
	 * has no default. See {@link contentSecurityPolicy}.
	 */
	contentSecurityPolicy?: ContentSecurityPolicyOptions;
	/**
	 * The plugin from `runtimeEnv(schema)`. It writes the public values into
	 * each HTML document, prerendered pages included.
	 */
	env?: RuntimeEnv<unknown>;
	/**
	 * The app's own plugins that see every response, prerendered pages
	 * included, such as an auth check. They go after the plugins of the
	 * options above and before the static stages.
	 */
	beforeStatic?: readonly Plugin[];
};

/**
 * The default pipeline, in order: `health`, `requestId`, `accessLog`,
 * `streamingCompress`, `securityHeaders`, `bodyLimit`, `noindex` (when
 * set), `buildId`, `contentSecurityPolicy` (when set), `env` (when set), the
 * `beforeStatic` plugins, `assets`, `redirects` (when the option has rules),
 * `trailingSlash`, `prerendered`, and `privateDocuments`. It is a plain
 * array, so an app can filter it or splice into it. To find a plugin in the
 * array, compare its `name`: the name of its function in kebab-case, such as
 * `streaming-compress`. A filter on a name that no plugin has removes nothing.
 *
 * @example
 * createServer({
 * 	plugins: defaultPlugins({ env, noindex: process.env.PREVIEW === "1", health: { ready: async () => db.ping() } }),
 * });
 *
 * @example
 * // Behind a proxy that compresses each response.
 * createServer({
 * 	plugins: defaultPlugins().filter((plugin) => plugin.name !== "streaming-compress"),
 * });
 */
export function defaultPlugins(options: DefaultPluginsOptions = {}): Plugin[] {
	const maxBytes = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	return [
		// Why first: a probe skips the access log, and a load balancer gets its answer with no other work.
		...(options.health === false ? [] : [health(options.health)]),
		requestId(options.requestId),
		accessLog(options.accessLog),
		streamingCompress(),
		// Why before `bodyLimit`: its 413 must also get the security headers.
		...(options.securityHeaders === false ? [] : [securityHeaders(options.securityHeaders)]),
		...(maxBytes === false ? [] : [bodyLimit({ maxBytes })]),
		// Why before the static stages: these plugins must see the prerendered pages. Why before
		// `beforeStatic`: an app plugin, such as an auth check, then gets the CSP nonce, and its own
		// responses get these headers. Their order among themselves changes no response.
		...(options.noindex == null || options.noindex === false
			? []
			: [options.noindex === true ? noindex() : noindex(options.noindex)]),
		...(options.buildId === false ? [] : [buildId(options.buildId)]),
		...(options.contentSecurityPolicy == null
			? []
			: [contentSecurityPolicy(options.contentSecurityPolicy)]),
		...(options.env == null ? [] : [options.env]),
		...(options.beforeStatic ?? []),
		assets(),
		...(options.redirects == null || options.redirects.length === 0
			? []
			: [redirects(options.redirects, { trailingSlash: options.trailingSlash ?? "never" })]),
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
	/**
	 * Hooks that change each log line of the server and of `logger()`, such
	 * as to redact a field.
	 */
	log?: LogOptions;
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

/** Why: `setTimeout` turns a longer delay into 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** Throws for a value that is not an integer from 0 to `max`, so a bad option stops startup. */
function checkCount(name: string, value: number, max = Number.MAX_SAFE_INTEGER): void {
	if (!Number.isInteger(value) || value < 0 || value > max) {
		const range = max === Number.MAX_SAFE_INTEGER ? "of 0 or more" : `from 0 to ${max}`;
		throw new Error(`${name} must be an integer ${range}, not ${value}.`);
	}
}

/**
 * The request with the scheme from `X-Forwarded-Proto`, when that header holds one.
 *
 * @example
 * withForwardedProto(new Request("http://example.com/", { headers: { "X-Forwarded-Proto": "https" } })).url;
 * // => "https://example.com/"
 */
export function withForwardedProto(request: Request): Request {
	const proto = request.headers.get("X-Forwarded-Proto");
	// Why check the scheme first: a new `Request` costs a copy of the request on each call.
	if ((proto !== "http" && proto !== "https") || request.url.startsWith(`${proto}:`)) {
		return request;
	}
	const url = new URL(request.url);
	url.protocol = `${proto}:`;
	// Why copy it first: the Node listener gives a light request, which `new Request` copies only as
	// its first argument. As the second, its getters throw "Illegal invocation".
	const copy = new Request(url, new Request(request));
	// Why: a `Request` cannot hold TRACE, so the Node listener gives a GET request that says TRACE.
	// The copy must say TRACE too, or a GET route answers it.
	if (copy.method !== request.method) {
		Object.defineProperty(copy, "method", { value: request.method });
	}
	return copy;
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
 * Two plugins of one option of `defaultPlugins()`, such as two `buildId()`,
 * stop startup.
 *
 * @example
 * // server.ts
 * const app = createServer({ logger: slogSink, plugins: defaultPlugins({ env }) });
 * app.get("/api/status", (c) => c.json({ ok: true }));
 * export default app;
 */
export function createServer({
	plugins = defaultPlugins(),
	logger: sink = jsonSink(),
	log,
	listeners,
	trustForwardedProto = false,
	trustedProxyHops = 0,
	shutdownDelayMs = 0,
	shutdownDeadlineMs = 10_000,
}: CreateServerOptions = {}): AppServer {
	checkPluginObjects(plugins);
	checkOptionPlugins(plugins);
	checkCount("trustedProxyHops", trustedProxyHops);
	checkCount("shutdownDelayMs", shutdownDelayMs, MAX_TIMER_MS);
	checkCount("shutdownDeadlineMs", shutdownDeadlineMs, MAX_TIMER_MS);
	const logger = hookSink(sink, log);
	setProcessSink(logger);
	const app = new Hono<AppServerEnv>();
	// Why keep the handler: a header hook that throws gets the app's `onError` answer, as a stage does.
	let onError: ErrorHandler<AppServerEnv> = answerError;
	const setOnError = app.onError.bind(app);
	setOnError(answerError);
	app.onError = (handler) => {
		onError = checkedOnError(handler);
		return setOnError(onError);
	};
	const answerThrown = async (thrown: unknown, context: Context<AppServerEnv>) =>
		onError(asError(thrown), context);
	let requestStore: RequestStore | undefined;
	if (trustForwardedProto) {
		// Why wrap `fetch`: every plugin and route, not only the framework, must see the trusted scheme.
		const dispatch = app.fetch;
		app.fetch = async (request, ...rest) => dispatch(withForwardedProto(request), ...rest);
	}
	// Why not each plugin: one with only `setup` or `onShutdown` has no work in a request.
	// Why copies: the server reads the `middleware` and the `etagPart` of each plugin one time, here.
	const stages = plugins.flatMap(({ middleware, etagPart }) =>
		middleware == null && etagPart == null ? [] : [{ middleware, etagPart }],
	);
	/**
	 * Runs the stage at `index` for the request of `run`. The stage runs each
	 * later stage through its `next`. After the last stage, `run.rest` runs the
	 * app's routes and the framework. `run.reached` is the last stage that
	 * started, so a second `next()` in one stage throws, as in Hono.
	 *
	 * Why not one Hono middleware for each plugin: Hono runs an async function
	 * for each one, and a second one must turn a thrown value that is not an
	 * `Error` into one. This function does both jobs. As Hono does for an
	 * `Error`, it answers each thrown value with `onError` at the stage that
	 * threw, so each earlier plugin sees that answer after its `next()`.
	 */
	const runStage = async (
		run: { context: Context<AppServerEnv, string>; rest: Next; reached: number },
		index: number,
	): Promise<void> => {
		if (index <= run.reached) {
			throw new Error("next() called multiple times");
		}
		run.reached = index;
		const { context } = run;
		const stage = stages[index];
		try {
			if (stage == null) {
				await run.rest();
				return;
			}
			const part = stage.etagPart?.();
			if (part != null) {
				context.set("etagParts", [...(context.get("etagParts") ?? []), part]);
			}
			// oxlint-disable-next-line typescript/promise-function-async -- `runStage` is async, and a second async function costs each stage a promise.
			const next = () => runStage(run, index + 1);
			const answer = await (stage.middleware == null ? next() : stage.middleware(context, next));
			// Why a truthy test: as in Hono, a value such as `false` from `allowed && next()` is no answer.
			// Why `finalized`: a response that a stage returns after its `next()` does not replace the answer.
			if (answer && !context.finalized) {
				context.res = answer;
			}
		} catch (error) {
			context.error = asError(error);
			context.res = await onError(context.error, context);
		}
	};
	app.use(async (context, next) => {
		const requestLog = requestLogger(logger, context);
		context.set("logger", requestLog);
		const remoteAddress = context.env?.remoteAddress;
		context.set(
			"clientAddress",
			trustedProxyHops === 0
				? remoteAddress
				: (forwardedClient(context.req.header("X-Forwarded-For"), trustedProxyHops) ??
						remoteAddress),
		);
		// Why lists here: each stage's header hook then changes the head once, where the response
		// leaves, and each report gets the response that leaves.
		const hooks: HeaderHook[] = [];
		const reports: ((sent: SentResponse) => void)[] = [];
		context.set("headerHooks", hooks);
		context.set("sentReports", reports);
		const given = context.env?.edge;
		// Why claim before the stages: a request that the app sends through itself again with `c.env`
		// gets the same edge, and must change its own response.
		const edge = given?.claim(requestLog) === true ? given : undefined;
		// Why finish in the request context: a header hook can read `requestContext()`.
		await withRequestContext(requestStore, context, async () => {
			await runStage({ context, rest: next, reached: -1 }, 0);
			// Why here: Hono makes this check after this stage returns. By then, with no edge, the
			// header hooks have made an empty 200 the response of the request.
			if (!context.finalized) {
				context.res = await answerThrown(
					new Error(
						"No stage answered the request. A middleware must return a Response or call `await next()`.",
					),
					context,
				);
			}
			const finishing = finishResponse(context, { hooks, reports, edge, fail: answerThrown });
			if (finishing != null) {
				await finishing;
			}
		});
		// Why cancel: Hono drops the body of a HEAD response without a cancel, so a stream would run on.
		if (context.req.method === "HEAD") {
			await context.res.body?.cancel();
		}
	});

	let prepared: Promise<void> | undefined;
	let running: RunningServer | undefined;
	let stoppingPlugins: Promise<void> | undefined;
	const internals: ServerInternals = {
		logger,
		presenceHeaders: presenceHeadersOf(plugins),
		setRequestStore: (store) => {
			requestStore = store;
		},
		prepare: async (info) => {
			prepared ??= (async () => {
				for (const plugin of plugins) {
					await plugin.setup?.(info);
				}
				app.all("*", async (context) => context.env.framework.fetch(context.req.raw, context));
			})().catch((error: unknown) => {
				// Why: the next request on a serverless host runs each `setup` again.
				prepared = undefined;
				throw error;
			});
			return prepared;
		},
		listen: async (framework, defaultListeners) => {
			if (running != null) {
				throw new Error("This app server is already listening.");
			}
			const chosen = listeners ?? defaultListeners ?? [];
			if (chosen.length === 0) {
				throw new Error(
					"This app server has no listener: the app sets none, and the host has none. A serverless host calls the entry's `fetch`.",
				);
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
				chosen.map(async (listener) => listener.start(fetch, { trustForwardedProto })),
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
			logger.log({ level: "info", message: "listening", attributes: { "app_server.urls": urls } });
			let stopping: Promise<void> | undefined;
			running = {
				urls,
				shutdown: async () => {
					stopping ??= (async () => {
						markStopping();
						if (shutdownDelayMs > 0) {
							logger.log({
								level: "info",
								message: "waiting before the drain",
								attributes: {
									"app_server.delay_ms": shutdownDelayMs,
								},
							});
							await new Promise((resolve) => {
								setTimeout(resolve, shutdownDelayMs);
							});
						}
						logger.log({
							level: "info",
							message: "draining",
							attributes: { "app_server.deadline_ms": shutdownDeadlineMs },
						});
						abortShutdownSignal();
						let openListeners = started.length;
						const deadline = setTimeout(() => {
							deadlinePassed = true;
							// Why only with an open listener: a plugin that hangs gets its own line.
							if (openListeners > 0) {
								logger.log({
									level: "warn",
									message: "the drain deadline passed with open requests",
									attributes: { "app_server.deadline_ms": shutdownDeadlineMs },
								});
							}
						}, shutdownDeadlineMs);
						// Why at the same time: a plugin that hangs must not keep the listeners open.
						// Why settle all: the process exits after shutdown, so one failed stop must not cut
						// the other stops short.
						const results = await Promise.allSettled([
							internals.stopPlugins(),
							...started.map(async (listener) => {
								try {
									await listener.stop({ deadlineMs: shutdownDeadlineMs });
								} finally {
									openListeners -= 1;
								}
							}),
						]);
						clearTimeout(deadline);
						const rejected = results.find((result) => result.status === "rejected");
						if (rejected != null) {
							throw rejected.reason;
						}
						logger.log({ level: "info", message: "stopped", attributes: {} });
					})();
					return stopping;
				},
			};
			return running;
		},
		stopPlugins: async () => {
			stoppingPlugins ??= (async () => {
				const open = new Set<Plugin>();
				const hooks = (async () => {
					await Promise.all(
						plugins.map(async (plugin) => {
							if (plugin.onShutdown == null) {
								return;
							}
							open.add(plugin);
							try {
								await plugin.onShutdown();
							} catch (error) {
								// Why here: a hook that hangs must not hold back the error of another hook.
								logger.log({
									level: "error",
									message: "plugin shutdown failed",
									attributes: { "app_server.plugin": plugin.name, error: asError(error) },
								});
							}
							open.delete(plugin);
						}),
					);
				})();
				if (!(await settlesWithin(hooks, shutdownDeadlineMs))) {
					logger.log({
						level: "warn",
						message: "plugin shutdown passed the deadline",
						attributes: {
							"app_server.deadline_ms": shutdownDeadlineMs,
							"app_server.plugins": [...open].map((plugin) => plugin.name),
						},
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
