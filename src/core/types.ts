import type { Context, MiddlewareHandler } from "hono";
import type { ResponseEdge } from "./response-edge.js";

/** A log level the server writes. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Where the server writes log lines. Pass the app's own formatter, or use
 * {@link jsonSink}. Attribute names are flat and dotted, such as `http.method`.
 */
export type LogSink = {
	log: (level: LogLevel, message: string, attributes: Readonly<Record<string, unknown>>) => void;
};

/** Hooks that change each log line before it goes to the {@link LogSink}. */
export type LogOptions = {
	/**
	 * Gives the attributes of each line, after the server flattens each error.
	 * Use it to add, change, or remove a field, such as to redact a value.
	 */
	attributes?: (
		level: LogLevel,
		message: string,
		attributes: Readonly<Record<string, unknown>>,
	) => Readonly<Record<string, unknown>>;
	/**
	 * Gives the fields of an attribute whose value is an `Error`, in place of
	 * the default fields. `prefix` is the attribute name, such as `error`.
	 */
	error?: (error: Error, prefix: string) => Readonly<Record<string, unknown>>;
};

/**
 * A logger with one method for each level. The logger of a request adds the
 * request ID, method, and path to each line. These fields win over a field
 * of the same name that the caller gives.
 */
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
	/** The nonce for the request's inline scripts, when the `contentSecurityPolicy` plugin runs. */
	cspNonce: string | undefined;
	/** The client's IP address, from `X-Forwarded-For` when `trustedProxyHops` is set, else from the socket. */
	clientAddress: string | undefined;
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
	 * The URL paths that the build prerenders, when the framework knows them.
	 * Else production reads the paths that the Vite plugin captured, and
	 * development has none to read.
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

/** A range of bytes in a file. `start` and `end` are both inclusive. */
export type ByteRange = { start: number; end: number };

/**
 * The files of the client build. Each path is a URL path that the static
 * stages checked: it starts with `/`, and it has no `..`, no `//`, and no
 * `\`.
 */
export type StaticFiles = {
	/** What is at `path`, or `undefined` when nothing is there. */
	stat: (path: string) => Promise<FileInfo | undefined>;
	/**
	 * The bytes of the file at `path`. With `range`, only the bytes from
	 * `start` to `end`, both inclusive. A host must honor `range`, because the
	 * static stages answer a `Range` request with these bytes. Open the file on
	 * the first read. Why: a stage can drop a response that no one reads.
	 */
	open: (path: string, range?: ByteRange) => Promise<ReadableStream<Uint8Array>>;
	/**
	 * A copy whose `stat` answers from a list of the files that it reads once.
	 * The production server uses it, because the client build does not change
	 * while the server runs. Without it, each lookup calls `stat`.
	 */
	snapshot?: () => Promise<StaticFiles>;
};

/** Request-scoped storage, such as `AsyncLocalStorage`. */
export type RequestStore = {
	/** Runs `work` with `value` as the stored value. */
	run: <Result>(value: Context<AppServerEnv>, work: () => Result) => Result;
	/** The stored value of the request that runs, else `undefined`. */
	get: () => Context<AppServerEnv> | undefined;
};

/** What went out for a response, when it ends or its client goes away. */
export type SentResponse = {
	/**
	 * The status that went out. It differs from the status of the response
	 * when a listener could not send the response, such as a 500 for a header
	 * value that it cannot write.
	 */
	status: number;
	/**
	 * The headers that went out with `status`, after each header hook. Read
	 * them here, not from `c.res`, which can lack the changes of the hooks: on
	 * Node.js and Vercel the hooks change the list that the listener writes,
	 * and Bun empties the headers of a response that it sent.
	 */
	headers: Pick<ResponseHeaders, "get" | "has">;
	/**
	 * The body bytes that went out, after compression. When `aborted` is
	 * true, the client can have got fewer.
	 */
	bytes: number;
	/** Whether the body stopped before its end, such as when the client went away or the body failed. */
	aborted: boolean;
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
	/**
	 * The listeners when the app sets none. A serverless host has none: it
	 * calls the entry's `fetch` for each request.
	 */
	listeners?: () => readonly Listener[];
	/** The storage for {@link requestContext}. Without it, `requestContext()` gives `undefined`. */
	storage?: RequestStore;
	/**
	 * Gzips a byte stream and flushes after each chunk. Without it and
	 * `brotli`, `streamingCompress` sends each response as it is.
	 */
	gzip?: (source: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
	/**
	 * Compresses a byte stream with brotli and flushes after each chunk.
	 * `streamingCompress` uses it for a client that prefers brotli to gzip.
	 */
	brotli?: (source: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
	lifecycle?: Lifecycle;
};

/**
 * What a listener passes to the app with each request. A host can add its own
 * values, such as Node's request and response.
 */
export type ListenerBindings = {
	/** The client's IP address, when the runtime knows it. */
	remoteAddress?: string | undefined;
	/**
	 * Given by a listener that writes each response itself, such as the node
	 * listener. See {@link ResponseEdge}.
	 */
	edge?: ResponseEdge | undefined;
	[binding: string]: unknown;
};

/** The Hono bindings of an app server: the listener's values and the framework. */
export type ServerBindings = ListenerBindings & {
	framework: FrameworkRuntime;
	/**
	 * Gets the URL path of the client build's file that `prerendered()` sends,
	 * such as `/about/index.html`. Only the build's check of the CDN pages
	 * gives it. Why a binding: each other request then pays one property read.
	 */
	onServedFile?: (path: string) => void;
};

/** The Hono environment of an app server. */
export type AppServerEnv = {
	Bindings: ServerBindings;
	Variables: {
		/** The request ID, set by the `requestId` plugin. */
		requestId?: string;
		logger: RequestLogger;
		/** The nonce for the request's inline scripts, set by the `contentSecurityPolicy` plugin. */
		cspNonce?: string;
		/**
		 * The URL path of the client build's HTML file that the response sends,
		 * such as `/about/index.html`. The static stages set it, for a 304 too.
		 */
		staticDocument?: string;
		/**
		 * The hashes of the inline scripts of an HTML file that the dev server
		 * sends as it is on disk, such as a file of Vite's public directory. The
		 * dev server stage sets it, for a 304 too.
		 */
		documentScriptHashes?: readonly string[];
		/**
		 * The route pattern that the framework matched, such as
		 * `/domains/:domainId`. The framework adapter sets it, and the access log
		 * writes it as `http.route`.
		 */
		routePattern?: string;
		/** The client's IP address. See `trustedProxyHops` on `createServer`. */
		clientAddress?: string | undefined;
		/** Attributes that each log line of the request carries, such as the trace IDs from the `requestId` plugin. */
		logAttributes?: Readonly<Record<string, unknown>>;
		/**
		 * The `etagPart` of each plugin that the request passed, in order. The
		 * static stages add them to each file's ETag. The server sets this list.
		 */
		etagParts?: readonly string[];
		/**
		 * Whether a stage that the request passed changes the bytes of an HTML
		 * body, as `runtimeEnv` does. The stage sets it before its `next()`.
		 * The static stages then send an HTML file as it is on disk, not its
		 * compressed copy, so the stage can change it.
		 */
		rewritesHtml?: boolean;
		/** The header hook of each stage that the request passed, in order. See {@link HeaderHook}. */
		headerHooks?: HeaderHook[];
		/** The reports of `onResponseSent` for the request. The server sets this list. */
		sentReports?: ((sent: SentResponse) => void)[];
	};
};

/** The headers of a response, for a {@link HeaderHook}. */
export type ResponseHeaders = {
	get: (name: string) => string | null;
	has: (name: string) => boolean;
	set: (name: string, value: string) => undefined;
	append: (name: string, value: string) => undefined;
	delete: (name: string) => undefined;
};

/**
 * A change to the headers of a response, from a stage that runs before the
 * response. In an app server, it changes the head once, where the response
 * leaves, after the code that each stage runs after its `next()`: the hook of
 * an inner stage runs first, so an outer stage has the last word. A hook that
 * throws gives a 500, as a stage that throws does. A dev server middleware
 * that sends its own response runs the hooks before it sends the head.
 *
 * The static stages and `streamingCompress` also run the hooks on a view of
 * the headers, to read the `Cache-Control` that leaves. So a hook can run two
 * or three times for one request: each run must give the same headers and do
 * nothing else, such as log, count, or store a value. A view run can come
 * before the code that a stage runs after its `next()`, and a throw in it
 * changes nothing.
 */
// Why `undefined`, not `void`: an async hook would run after the head goes out, so its headers would be lost.
export type HeaderHook = (headers: ResponseHeaders) => undefined;

/** The request handler that a listener calls. */
export type FetchHandler = (
	request: Request,
	bindings?: ListenerBindings,
) => Response | Promise<Response>;

/** What a plugin learns at startup, before the first request. */
export type SetupInfo = {
	/** The files of the client build. */
	files: StaticFiles;
	/** The headers of each prerendered file, by URL path, that the Vite plugin captured. */
	capturedHeaders: ReadonlyMap<string, Readonly<Record<string, string>>>;
	/**
	 * The base64 `SHA-256` of each inline script of each HTML file in the client
	 * build, by the file's URL path, that the Vite plugin recorded.
	 */
	scriptHashes: ReadonlyMap<string, readonly string[]>;
	/**
	 * The ID of the client build that the Vite plugin derived. It is
	 * `undefined` in development and for a build with no build manifest.
	 */
	buildId: string | undefined;
	/** Whether a URL path is a data request of the framework. */
	isDataRequest: (path: string) => boolean;
	/** Content types of the framework's files that `mime` does not know, by file extension. */
	contentTypes: Readonly<Record<string, string>>;
	/** The host's gzip stream, when it has one. */
	gzip: ((source: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>) | undefined;
	/** The host's brotli stream, when it has one. */
	brotli?: ((source: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>) | undefined;
	logger: LogSink;
} & (
	| {
			mode: "production";
			/** The URL paths that the build prerendered. */
			prerenderedPaths: readonly string[];
			/** The URL path of the hashed files of the client build, such as `/assets/`. */
			assetsPath: string;
	  }
	| {
			mode: "development";
			/** The dev server as a pipeline stage. It serves source modules, HMR, and CSS. */
			devServer: MiddlewareHandler<AppServerEnv>;
			/**
			 * The URL paths that the build will prerender, or `undefined` when the
			 * framework finds them only during the build, as TanStack Start does.
			 */
			prerenderedPaths: readonly string[] | undefined;
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
	/**
	 * Runs once before the server takes requests. A thrown error stops startup.
	 * On a serverless host, a thrown error fails the request, and the next
	 * request runs each `setup` again.
	 */
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
	start: (fetch: FetchHandler, options?: ListenerStartOptions) => Promise<StartedListener>;
};

/** What the server tells a listener when it starts it. */
export type ListenerStartOptions = {
	/**
	 * The `trustForwardedProto` of the server. A listener that builds each
	 * request itself can then take the scheme from `X-Forwarded-Proto` at once,
	 * so the server copies no request to change it.
	 * @default false
	 */
	trustForwardedProto?: boolean;
};
