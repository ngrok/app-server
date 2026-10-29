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

/** What {@link requestContext} gives for the request that runs. */
export type RequestContext = {
	/** The request ID, when the `requestId` plugin runs. */
	requestId: string | undefined;
	/** The request's logger. Its lines carry the request ID. */
	logger: RequestLogger;
};

/** The server mode. */
export type Mode = "production" | "development";

/**
 * The run side of a framework adapter: the framework that answers each
 * request that no plugin or route answers.
 */
export type FrameworkRuntime = {
	/** A name for logs and errors. */
	name: string;
	/** Renders one request. */
	fetch: (request: Request, context: Context<AppServerEnv>) => Promise<Response>;
	/**
	 * The client build, when the framework knows it. The entry that the Vite
	 * plugin generates gives it instead.
	 */
	clientDirectory?: string;
	/**
	 * The URL paths that the build prerendered, when the framework knows them.
	 * Else the server reads the paths that the Vite plugin captured.
	 */
	prerenderedPaths?: readonly string[];
	/** Whether a URL path is a data request, such as a React Router `.data` file. */
	isDataRequest?: (path: string) => boolean;
	/** Content types that `mime` does not know, by file extension, such as `{ ".data": "text/x-script" }`. */
	contentTypes?: Readonly<Record<string, string>>;
};

/** Makes the run side of a framework adapter from the framework's server module. */
export type FrameworkRuntimeFactory = (
	serverModule: unknown,
	info: { mode: Mode },
) => FrameworkRuntime;

/** What a host knows about a file under the client build. */
export type FileInfo = {
	kind: "file" | "directory";
	/** The size in bytes. */
	size: number;
	mtimeMs: number;
};

/**
 * The files of the client build. Each path is a URL path that the static
 * stages checked: it starts with `/`, and it has no `..`, no `//`, and no
 * `\`.
 */
export type StaticFiles = {
	/** What is at `path`, or `undefined` when nothing is there. */
	stat: (path: string) => Promise<FileInfo | undefined>;
	/** The bytes of the file at `path`. */
	open: (path: string) => Promise<ReadableStream<Uint8Array>>;
};

/** Request-scoped storage, such as `AsyncLocalStorage`. */
export type RequestStore = {
	/** Runs `work` with `value` as the stored value. */
	run: <Result>(value: Context<AppServerEnv>, work: () => Result) => Result;
	/** The stored value of the request that runs, else `undefined`. */
	get: () => Context<AppServerEnv> | undefined;
};

/** How a long-lived host stops. A serverless host has none. */
export type Lifecycle = {
	/**
	 * Calls `stop` once when the host must stop, such as on `SIGTERM`. The host
	 * exits when `stop` settles.
	 */
	onStop: (stop: () => Promise<void>) => void;
};

/** The run side of a host adapter: where the server runs. */
export type HostRuntime = {
	/** A name for logs and errors. */
	name: string;
	/** The files of the client build at `clientDirectory`, a file path or a `file:` URL. */
	files: (clientDirectory: string) => StaticFiles;
	/** The listeners when the app sets none. */
	listeners: () => readonly Listener[];
	/** The storage for {@link requestContext}. Without it, `requestContext()` gives `undefined`. */
	storage?: RequestStore;
	/**
	 * Gzips a byte stream and flushes after each chunk. Without it,
	 * `streamingCompress` sends each response as it is.
	 */
	gzip?: (source: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
	lifecycle?: Lifecycle;
};

/**
 * What a listener passes to the app with each request. A host can add its own
 * values, such as Node's request and response.
 */
export type ListenerBindings = {
	/** The client's IP address, when the runtime knows it. */
	remoteAddress?: string | undefined;
	[binding: string]: unknown;
};

/** The Hono bindings of an app server: the listener's values and the framework. */
export type ServerBindings = ListenerBindings & {
	framework: FrameworkRuntime;
};

/** The Hono environment of an app server. */
export type AppServerEnv = {
	Bindings: ServerBindings;
	Variables: {
		/** The request ID, set by the `requestId` plugin. */
		requestId?: string;
		logger: RequestLogger;
		/**
		 * The `etagPart` of each plugin that the request passed, in order. The
		 * static stages add them to each file's ETag. The server sets this list.
		 */
		etagParts?: readonly string[];
	};
};

/** The request handler that a listener calls. */
export type FetchHandler = (
	request: Request,
	bindings: ListenerBindings,
) => Response | Promise<Response>;

/** What a plugin learns at startup, before the first request. */
export type SetupInfo = {
	/** The files of the client build. */
	files: StaticFiles;
	/** The URL paths that the build prerendered. */
	prerenderedPaths: readonly string[];
	/** The headers of each prerendered file, by URL path, that the Vite plugin captured. */
	capturedHeaders: ReadonlyMap<string, Readonly<Record<string, string>>>;
	/** Whether a URL path is a data request of the framework. */
	isDataRequest: (path: string) => boolean;
	/** Content types of the framework's files that `mime` does not know, by file extension. */
	contentTypes: Readonly<Record<string, string>>;
	/** The host's gzip stream, when it has one. */
	gzip: ((source: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>) | undefined;
	logger: LogSink;
} & (
	| { mode: "production" }
	| {
			mode: "development";
			/** The dev server as a pipeline stage. It serves source modules, HMR, and CSS. */
			devServer: MiddlewareHandler<AppServerEnv>;
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
	/** Runs at shutdown while the listeners drain. The server stops waiting for it at the drain deadline. */
	onShutdown?: () => Promise<void>;
	/**
	 * A value that this plugin's changes to a response depend on, such as the
	 * env values it writes into each document. The server adds it to the ETag
	 * of each static file that the request reaches after this plugin, so a 304
	 * never keeps a response made with an old value. Return `undefined` when
	 * the plugin changes nothing.
	 */
	etagPart?: () => string | undefined;
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
