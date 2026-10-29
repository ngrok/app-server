import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context, MiddlewareHandler } from "hono";

/** A log level the server writes. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Where the server writes log lines. Pass the app's own formatter, or use
 * {@link jsonSink}. Attribute names are flat and dotted, such as `http.method`.
 */
export type LogSink = {
	log: (level: LogLevel, message: string, attributes: Readonly<Record<string, unknown>>) => void;
};

/** The logger for one request. Each line carries the request ID, method, and path. */
export type RequestLogger = Record<
	LogLevel,
	(message: string, attributes?: Readonly<Record<string, unknown>>) => void
>;

/** The framework that answers each request that no plugin or route answers. */
export type FrameworkAdapter = {
	/** Renders one request. */
	fetch: (request: Request, context: Context<AppServerEnv>) => Promise<Response>;
	/** The absolute path of the client build, such as `<root>/build/client`. */
	clientDirectory: string;
	/** The URL paths that the build prerendered. */
	prerenderedPaths: readonly string[];
};

/** What a listener passes to the app with each request. */
export type ListenerBindings = {
	/** The client's IP address, when the runtime knows it. */
	remoteAddress?: string;
	/** Node's request, on a `node:http` listener only. */
	incoming?: IncomingMessage;
	/** Node's response, on a `node:http` listener only. */
	outgoing?: ServerResponse;
};

/** The Hono bindings of an app server: the listener's values and the framework. */
export type ServerBindings = ListenerBindings & {
	framework: FrameworkAdapter;
};

/** The Hono environment of an app server. */
export type AppServerEnv = {
	Bindings: ServerBindings;
	Variables: {
		/** The request ID, set by the `requestId` plugin. */
		requestId?: string;
		logger: RequestLogger;
	};
};

/** The request handler that a listener calls. */
export type FetchHandler = (
	request: Request,
	bindings: ListenerBindings,
) => Response | Promise<Response>;

/** A Connect middleware, such as `vite.middlewares`. */
export type NodeMiddleware = (
	request: IncomingMessage,
	response: ServerResponse,
	next: (error?: unknown) => void,
) => void;

/** What a plugin learns at startup, before the first request. */
export type SetupInfo = {
	/** The absolute path of the client build. */
	clientDirectory: string;
	/** The URL paths that the build prerendered. */
	prerenderedPaths: readonly string[];
	logger: LogSink;
} & (
	| { mode: "production" }
	| {
			mode: "development";
			/** Vite's middleware stack, which serves source modules and HMR. */
			viteMiddleware: NodeMiddleware;
	  }
);

/**
 * One step of the request pipeline. Plugins run in list order, so the order is
 * the contract.
 *
 * @example
 * const livez: Plugin = {
 * 	name: "livez",
 * 	middleware: async (c, next) => (c.req.path === "/livez" ? c.text("ok") : next()),
 * };
 */
export type Plugin = {
	/** A name for logs and errors. */
	name: string;
	/** The Hono middleware for this step. */
	middleware?: MiddlewareHandler<AppServerEnv>;
	/** Runs once before the server takes requests. A thrown error stops startup. */
	setup?: (info: SetupInfo) => void | Promise<void>;
	/** Runs at shutdown, before the drain deadline. */
	onShutdown?: () => Promise<void>;
};

/** A running listener. */
export type StartedListener = {
	/** The URL the listener answers on. */
	url: string;
	/**
	 * Stops new connections and waits for open requests. At the deadline, it
	 * closes the connections that are still open.
	 */
	stop: (options: { deadlineMs: number }) => Promise<void>;
};

/**
 * How the server receives connections, separate from the request pipeline.
 *
 * @example
 * createServer({ listeners: [tcp({ port: 8080 })] });
 */
export type Listener = {
	/** A name for logs. */
	name: string;
	start: (fetch: FetchHandler) => Promise<StartedListener>;
};
