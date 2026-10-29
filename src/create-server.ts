import { Hono } from "hono";
import { errorAttributes, jsonSink, requestLogger } from "./log.js";
import { accessLog, type AccessLogOptions } from "./plugins/access-log.js";
import { requestId, type RequestIdOptions } from "./plugins/request-id.js";
import { assets, prerendered, type PrerenderedOptions } from "./plugins/static.js";
import { streamingCompress } from "./plugins/streaming-compress.js";
import { abortShutdownSignal, renewShutdownSignal } from "./shutdown.js";
import { tcp } from "./tcp.js";
import type {
	AppServerEnv,
	FetchHandler,
	FrameworkAdapter,
	Listener,
	LogSink,
	Plugin,
	SetupInfo,
} from "./types.js";

// Why a global symbol: the app comes from the bundled copy of this package, and the CLI is another copy.
const INTERNALS_KEY = Symbol.for("@ngrok/app-server/internals");

/** A Hono app from {@link createServer}. Add routes to it before you export it. */
export type AppServer = Hono<AppServerEnv>;

/** A server that listens. */
export type RunningServer = {
	/** The URL of each listener. */
	urls: readonly string[];
	/**
	 * Aborts `shutdownSignal()`, runs each plugin's `onShutdown`, then stops the
	 * listeners and drains open requests until the deadline.
	 */
	shutdown: () => Promise<void>;
};

/** What the CLI calls on an app. Both copies of the package share this shape. */
export type ServerInternals = {
	logger: LogSink;
	/** Runs each plugin's `setup` once and adds the framework handler after the app's routes. */
	prepare: (info: SetupInfo) => Promise<void>;
	/** Starts the listeners. Call `prepare` first. */
	listen: (framework: FrameworkAdapter) => Promise<RunningServer>;
};

/** Options for {@link defaultPlugins}. */
export type DefaultPluginsOptions = {
	requestId?: RequestIdOptions;
	accessLog?: AccessLogOptions;
	prerendered?: PrerenderedOptions;
	/**
	 * Plugins that go after compression and before the static stages, so they
	 * see every response, prerendered pages included. `runtimeEnv` and
	 * `buildId` go here.
	 */
	beforeStatic?: readonly Plugin[];
};

/**
 * The default pipeline, in order: `requestId`, `accessLog`,
 * `streamingCompress`, the `beforeStatic` plugins, `assets`, and
 * `prerendered`. It is a plain array, so an app can filter it or splice into it.
 *
 * @example
 * createServer({ plugins: defaultPlugins({ accessLog: { redactQuery: false }, beforeStatic: [env] }) });
 */
export function defaultPlugins(options: DefaultPluginsOptions = {}): Plugin[] {
	return [
		requestId(options.requestId),
		accessLog(options.accessLog),
		streamingCompress(),
		...(options.beforeStatic ?? []),
		assets(),
		prerendered(options.prerendered),
	];
}

/** Options for {@link createServer}. */
export type CreateServerOptions = {
	/** @default defaultPlugins() */
	plugins?: readonly Plugin[];
	/** @default jsonSink() */
	logger?: LogSink;
	/** @default [tcp()] */
	listeners?: readonly Listener[];
	/**
	 * Read the request scheme from `X-Forwarded-Proto`. Set it only behind a
	 * proxy that overwrites that header, else a client can spoof it.
	 * @default false
	 */
	trustForwardedProto?: boolean;
	/**
	 * How long open requests get to finish after a stop signal.
	 * @default 10000
	 */
	shutdownDeadlineMs?: number;
};

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
	listeners = [tcp()],
	trustForwardedProto = false,
	shutdownDeadlineMs = 10_000,
}: CreateServerOptions = {}): AppServer {
	const app = new Hono<AppServerEnv>();
	app.use(async (context, next) => {
		context.set("logger", requestLogger(logger, context));
		await next();
	});
	for (const plugin of plugins) {
		if (plugin.middleware != null) {
			app.use(plugin.middleware);
		}
	}
	app.onError((error, context) => {
		context.var.logger.error("unhandled error", errorAttributes(error));
		return context.text("Internal Server Error", 500);
	});

	let prepared: Promise<void> | undefined;
	let running: RunningServer | undefined;
	const internals: ServerInternals = {
		logger,
		prepare: (info) => {
			prepared ??= (async () => {
				for (const plugin of plugins) {
					await plugin.setup?.(info);
				}
				app.all("*", (context) =>
					context.env.framework.fetch(
						trustForwardedProto ? withForwardedProto(context.req.raw) : context.req.raw,
						context,
					),
				);
			})();
			return prepared;
		},
		listen: async (framework) => {
			if (running != null) {
				throw new Error("This app server is already listening.");
			}
			renewShutdownSignal();
			const fetch: FetchHandler = (request, bindings) =>
				app.fetch(request, { ...bindings, framework });
			const started = await Promise.all(listeners.map((listener) => listener.start(fetch)));
			const urls = started.map((listener) => listener.url);
			logger.log("info", "listening", { "app_server.urls": urls });
			let stopping: Promise<void> | undefined;
			running = {
				urls,
				shutdown: () => {
					stopping ??= (async () => {
						logger.log("info", "draining", { "app_server.deadline_ms": shutdownDeadlineMs });
						abortShutdownSignal();
						const results = await Promise.allSettled(
							plugins.map(async (plugin) => plugin.onShutdown?.()),
						);
						for (const result of results) {
							if (result.status === "rejected") {
								logger.log("error", "plugin shutdown failed", errorAttributes(result.reason));
							}
						}
						await Promise.all(
							started.map((listener) => listener.stop({ deadlineMs: shutdownDeadlineMs })),
						);
						logger.log("info", "stopped", {});
					})();
					return stopping;
				},
			};
			return running;
		},
	};
	Object.defineProperty(app, INTERNALS_KEY, { value: internals });
	return app;
}

function isServerInternals(value: unknown): value is ServerInternals {
	return (
		typeof value === "object" &&
		value != null &&
		"prepare" in value &&
		typeof value.prepare === "function" &&
		"listen" in value &&
		typeof value.listen === "function" &&
		"logger" in value
	);
}

/** The internals of an app from {@link createServer}, from either copy of the package, else `undefined`. */
export function serverInternals(value: unknown): ServerInternals | undefined {
	if (typeof value !== "object" || value == null) {
		return undefined;
	}
	const internals: unknown = Reflect.get(value, INTERNALS_KEY);
	return isServerInternals(internals) ? internals : undefined;
}
