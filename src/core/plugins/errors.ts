import type { Context } from "hono";
import { checkCount } from "../check-count.js";
import {
	CLIENT_ERROR_SOURCES,
	clientErrorsPath,
	MAX_REPORT_BYTES,
} from "../client-error-report.js";
import type { ClientErrorReport, ClientErrorSource } from "../client-error-report.js";
import { asError } from "../log.js";
import { optionPlugin } from "../plugin-options.js";
import { settlesWithin } from "../settles-within.js";
import type { AppServerEnv, Plugin, RequestLogger } from "../types.js";

/** One frame of the stack of an {@link AppErrorEvent}. */
export type AppErrorFrame = {
	/** The function name, when the stack gave one. */
	function: string | undefined;
	/**
	 * The script of the frame: a URL, such as `https://example.com/assets/home-3f9a1c.js`, for a
	 * client error, and a path or a `file:` URL for a server error.
	 */
	file: string;
	line: number;
	column: number;
};

/** The fields of each {@link AppErrorEvent}, from the client and from the server. */
type AppErrorFields = {
	/** The name of the error, such as `TypeError`. */
	name: string;
	message: string;
	/** The frames of the stack, from the frame that threw. A client error has one frame or more. */
	frames: readonly AppErrorFrame[];
	/** The route pattern, such as `/domains/:domainId`, when the router gave one. */
	route: string | undefined;
	/** The pathname of the page or of the request, with no query and no fragment. */
	path: string;
	userAgent: string;
	/**
	 * The build: for a client error, the build that the page runs, when `buildId()` sent one, and it
	 * can be older than the build of the server. For a server error, the build that `buildId()`
	 * sends.
	 */
	buildId: string | undefined;
};

/**
 * One error that {@link errors} gives to its `filter` and its `sink`. `side`
 * tells where the error happened:
 *
 * - `client`: the inline script of `clientErrorsScript()` sent it. `source`
 *   tells where the browser got it. Each field comes from the client.
 * - `server`: a request failed with a 5xx in the server. `error` is the
 *   thrown error. `source` is `pipeline` for an error that a plugin, a route,
 *   or the framework threw, and `framework` for an error that React Router
 *   caught in a loader, an action, or a render.
 */
export type AppErrorEvent =
	| (AppErrorFields & { side: "client"; source: ClientErrorSource })
	| (AppErrorFields & { side: "server"; source: "pipeline" | "framework"; error: Error });

/** What the `filter` and the `sink` of {@link errors} also get with each event. */
export type AppErrorContext = {
	/**
	 * The request: the report of the browser for a client error, and the
	 * request that failed for a server error. Read headers such as `Referer`
	 * and `traceparent` from it.
	 */
	request: Request;
};

/** Options for {@link errors}. */
export type ErrorsOptions = {
	/**
	 * Takes each event, such as to send it to an error tracker. The server
	 * waits for it for 3 seconds at most before it answers, so a serverless
	 * host does not stop it. A sink that throws or rejects logs one error line.
	 * @default one `client error` line of the request's logger for a client error, with the level `error`. A server error already has the `unhandled error` line of the server.
	 */
	sink?: (event: AppErrorEvent, context: AppErrorContext) => void | Promise<void>;
	/** Whether the sink gets an event. Give `false` for noise that the app knows. */
	filter?: (event: AppErrorEvent, context: AppErrorContext) => boolean;
	/**
	 * How many client errors the sink gets in one minute, in this process.
	 * Each report after them gets a 429. A report that the plugin or the
	 * `filter` drops does not count, and a server error does not count. `0`
	 * gives the sink no client error.
	 * @default 60
	 */
	maxPerMinute?: number;
};

/** How long the server waits for the sink. */
const SINK_DEADLINE_MS = 3000;

/** Why 50: the frames after them seldom show the cause, and a sink pays for each one. */
const MAX_FRAMES = 50;

/** The user agent of a client that is not a visitor, such as a crawler or a headless browser. */
const BOT = /bot|crawl|spider|headless|lighthouse/iu;

/** The file, the line, and the column at the end of a frame. */
const LOCATION = /^(?<file>\S+):(?<line>\d+):(?<column>\d+)$/u;

/**
 * The frame of one line of a stack: `at name (file:1:2)` and `at file:1:2`
 * of V8, each with or without `async`, and `name@file:1:2` and `file:1:2` of
 * Firefox and Safari. A line that is not a frame gives `undefined`.
 *
 * Why no single pattern: a client writes the stack, and a pattern with an
 * optional name takes quadratic time on a long line that is not a frame.
 */
function frameOf(line: string): AppErrorFrame | undefined {
	let location = line.trim();
	let name = "";
	if (location.startsWith("at ")) {
		location = location.slice(3).replace(/^async /u, "");
		// Why the first ` (`: the URL of a file can have parentheses, such as `/assets/(group)-3f9a1c.js`.
		const open = location.indexOf(" (");
		if (open !== -1 && location.endsWith(")")) {
			name = location.slice(0, open);
			location = location.slice(open + 2, -1);
		}
	} else {
		// Why not after `://`: the URL of a file can have an `@`, such as `/assets/@scope/a.js`.
		const at = location.indexOf("@");
		if (at !== -1 && !location.slice(0, at).includes("://")) {
			name = location.slice(0, at);
			location = location.slice(at + 1);
		}
	}
	const groups = LOCATION.exec(location)?.groups;
	return groups?.file == null
		? undefined
		: {
				function: name === "" ? undefined : name,
				file: groups.file,
				line: Number(groups.line),
				column: Number(groups.column),
			};
}

/** The frames of `stack`, {@link MAX_FRAMES} at most. */
function framesOf(stack: string): AppErrorFrame[] {
	const frames: AppErrorFrame[] = [];
	for (const line of stack.split("\n")) {
		const frame = frameOf(line);
		if (frame != null) {
			frames.push(frame);
			if (frames.length === MAX_FRAMES) {
				break;
			}
		}
	}
	return frames;
}

/**
 * The frames of a server error. Why remove the header: V8 starts the stack
 * with the name and the message, and a message can have a line that looks
 * like a frame, such as the stack of another error.
 */
function serverFramesOf({ name, message, stack = "" }: Error): AppErrorFrame[] {
	const header = message === "" ? name : `${name}: ${message}`;
	return framesOf(stack.startsWith(header) ? stack.slice(header.length) : stack);
}

/**
 * The text of the body of `request`, or `undefined` for a body of more than
 * {@link MAX_REPORT_BYTES}. Why not `hono/body-limit`: it does not cancel a
 * streamed body that it refuses, so the source of the stream stays open.
 */
async function bodyOf(request: Request): Promise<string | undefined> {
	const reader = request.body?.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- each chunk comes after the one before it.
		const chunk = await reader?.read();
		if (chunk == null || chunk.done) {
			return text + decoder.decode();
		}
		bytes += chunk.value.byteLength;
		if (bytes > MAX_REPORT_BYTES) {
			// oxlint-disable-next-line no-await-in-loop -- the loop ends here.
			await reader?.cancel();
			return undefined;
		}
		text += decoder.decode(chunk.value, { stream: true });
	}
}

/** `text` as JSON, or `undefined` when it is not JSON. */
function parsed(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** `value` as a report, or `undefined` when a field has a wrong type. */
function asReport(value: unknown): ClientErrorReport | undefined {
	if (typeof value !== "object" || value == null) {
		return undefined;
	}
	const fields: Record<string, unknown> = { ...value };
	const { name, message, stack, source, path, route, build } = fields;
	const sourceName = CLIENT_ERROR_SOURCES.find((known) => known === source);
	if (
		typeof name !== "string" ||
		typeof message !== "string" ||
		typeof stack !== "string" ||
		sourceName == null ||
		typeof path !== "string" ||
		!path.startsWith("/") ||
		(route != null && typeof route !== "string") ||
		(build != null && typeof build !== "string")
	) {
		return undefined;
	}
	return {
		name,
		message,
		stack,
		source: sourceName,
		path,
		route: route ?? undefined,
		build: build ?? undefined,
	};
}

/**
 * Whether the page that sent the request has the origin of the server. Why
 * `Sec-Fetch-Site` first: a proxy that changes the host or ends TLS does not
 * change it. A browser that does not send it sends `Origin` with a `POST`.
 * Why the whole origin there: a page on `http:` of the same host is another
 * origin. Behind a proxy that ends TLS, `trustForwardedProto` gives the
 * request its `https:`.
 */
function isSameOrigin(context: Context<AppServerEnv>): boolean {
	const site = context.req.header("Sec-Fetch-Site");
	if (site != null) {
		return site === "same-origin";
	}
	return URL.parse(context.req.header("Origin") ?? "")?.origin === new URL(context.req.url).origin;
}

/** An answer with no body. */
function empty(status: 204 | 400 | 403 | 413 | 429): Response {
	return new Response(null, { status });
}

/** The default sink for a client error: one error line. Why an `Error`: the `log` hooks of `createServer` then get it. */
function logEvent(logger: RequestLogger, event: AppErrorEvent): void {
	const error = new Error(event.message);
	error.name = event.name;
	error.stack = event.frames
		.map(({ function: name, file, line, column }) =>
			name == null ? `${file}:${line}:${column}` : `${name} (${file}:${line}:${column})`,
		)
		.join("\n");
	logger.error("client error", {
		error,
		"app_server.client.source": event.source,
		"app_server.client.route": event.route,
		"app_server.client.path": event.path,
		"app_server.client.build_id": event.buildId,
	});
}

/**
 * Gives each error of the app to one sink: the errors of the client code and
 * the errors of the server. So an app sends both to one error tracker from
 * the server, with no vendor script in the browser.
 *
 * - Client errors: the inline script of `clientErrorsScript()` from
 *   `@ngrok/app-server/client` sends each report as a `POST` to the path:
 *   `/_app/issues`, or the `clientErrorsPath` of the `appServer` Vite plugin.
 * - Server errors: a request whose answer is a 5xx because a plugin, a
 *   route, or the framework threw, and an error that React Router caught in
 *   a loader, an action, or a render. The plugin sees the errors of the
 *   stages after it only.
 *
 * The plugin answers a report before the framework runs. A report gets a 204
 * when the plugin takes it or drops it, and:
 *
 * - a 403 from a page of another origin,
 * - a 413 for a body of more than 6 KiB,
 * - a 400 for a body that is not a report,
 * - a 429 after the sink got `maxPerMinute` client errors in one minute.
 *
 * The plugin drops a report from a bot, and one whose stack has no frame. In
 * production, it also drops one whose first frame is not a file of Vite's
 * `build.assetsDir`, such as an inline script that a browser extension adds.
 * Then the `filter` decides, and the `sink` gets the event. Each field of a
 * client event comes from the client, and a client that is not a browser can
 * send any value, so a sink must not trust it.
 *
 * The limit counts in the memory of one process. On a serverless host, each
 * instance has its own count, so the limit of the sink's service is the hard
 * limit there. A `maxPerMinute` that is not a whole number of 0 or more
 * stops startup.
 *
 * @example
 * createServer({
 * 	plugins: defaultPlugins({
 * 		errors: {
 * 			filter: (event) => !event.message.includes("AbortError"),
 * 			sink: async (event) => {
 * 				await fetch("https://errors.example.com/events", { method: "POST", body: JSON.stringify(event) });
 * 			},
 * 		},
 * 	}),
 * });
 */
export function errors({ sink, filter, maxPerMinute = 60 }: ErrorsOptions = {}): Plugin {
	/** Why in `setup`: the server entry sets the path before the setup, and can set it after this call. */
	let path = "";
	checkCount("The maxPerMinute of errors", maxPerMinute);
	/** In development, each file is an app file: Vite serves source modules from many paths. */
	let assetsPath = "/";
	let buildId: string | undefined;
	let minuteStart = 0;
	let taken = 0;
	const isOverLimit = (): boolean => {
		const now = Date.now();
		if (now - minuteStart >= 60_000) {
			minuteStart = now;
			taken = 0;
		}
		taken += 1;
		return taken > maxPerMinute;
	};
	/** Gives `event` to the sink, and waits for it for {@link SINK_DEADLINE_MS} at most. */
	const send = async (
		context: Context<AppServerEnv>,
		event: AppErrorEvent,
		sinkContext: AppErrorContext,
	): Promise<void> => {
		const logger = context.get("logger");
		if (sink == null) {
			if (event.side === "client") {
				logEvent(logger, event);
			}
			return;
		}
		// Why wait: a serverless host can stop the function when it answers.
		const sent = (async () => {
			try {
				await sink(event, sinkContext);
			} catch (error) {
				logger.error("error sink failed", { error: asError(error) });
			}
		})();
		if (!(await settlesWithin(sent, SINK_DEADLINE_MS))) {
			logger.warn("error sink passed the deadline", {
				"app_server.deadline_ms": SINK_DEADLINE_MS,
			});
		}
	};
	const receive = async (context: Context<AppServerEnv>): Promise<Response> => {
		if (!isSameOrigin(context)) {
			return empty(403);
		}
		// Why before the read: a body that is too large by its length gets the answer with no wait.
		if (
			Number(context.req.header("Content-Length")) > MAX_REPORT_BYTES &&
			context.req.header("Transfer-Encoding") == null
		) {
			return empty(413);
		}
		// Why an empty text for a body that fails: a client that leaves gets the 400 of a bad report.
		const text = await bodyOf(context.req.raw).catch(() => "");
		if (text == null) {
			return empty(413);
		}
		const report = asReport(parsed(text));
		if (report == null) {
			return empty(400);
		}
		const userAgent = context.req.header("User-Agent") ?? "";
		if (userAgent === "" || BOT.test(userAgent)) {
			return empty(204);
		}
		const frames = framesOf(report.stack);
		const event: AppErrorEvent = {
			side: "client",
			name: report.name,
			message: report.message,
			frames,
			source: report.source,
			route: report.route,
			path: report.path,
			userAgent,
			buildId: report.build,
		};
		const sinkContext = { request: context.req.raw };
		if (
			URL.parse(frames[0]?.file ?? "")?.pathname.startsWith(assetsPath) !== true ||
			filter?.(event, sinkContext) === false
		) {
			return empty(204);
		}
		// Why after the drops: a report that the sink does not get must not use the limit.
		if (isOverLimit()) {
			return empty(429);
		}
		await send(context, event, sinkContext);
		return empty(204);
	};
	/** Gives the sink each error of a request that failed with a 5xx in a later stage. */
	const failed = async (context: Context<AppServerEnv>): Promise<void> => {
		const caught = context.get("frameworkErrors") ?? [];
		// Why the status: a 4xx, such as a thrown `HTTPException` or a route that React Router does not
		// match, is not a server failure. Why `aborted`: the client left, so the error is no failure.
		if (
			(context.error == null && caught.length === 0) ||
			context.res.status < 500 ||
			context.req.raw.signal.aborted
		) {
			return;
		}
		const thrown = [
			...caught.map((error) => ({ error, source: "framework" as const })),
			...(context.error == null ? [] : [{ error: context.error, source: "pipeline" as const }]),
		];
		const sinkContext = { request: context.req.raw };
		await Promise.all(
			thrown
				// Why: an error with a 4xx status, such as the `HTTPException` of `bodyLimit` that a
				// framework caught, is an answer to the client, even when the framework answered 500.
				.filter(({ error }) => !(Number(Reflect.get(error, "status")) < 500))
				.map(async ({ error, source }) => {
					const event: AppErrorEvent = {
						side: "server",
						source,
						error,
						name: error.name,
						message: error.message,
						frames: serverFramesOf(error),
						route: context.get("routePattern"),
						path: context.req.path,
						userAgent: context.req.header("User-Agent") ?? "",
						buildId: context.get("buildId") ?? buildId,
					};
					if (filter?.(event, sinkContext) !== false) {
						await send(context, event, sinkContext);
					}
				}),
		);
	};
	return optionPlugin("errors", {
		name: "errors",
		setup: (info) => {
			path = clientErrorsPath();
			({ buildId } = info);
			if (info.mode === "production") {
				({ assetsPath } = info);
			}
		},
		// oxlint-disable-next-line typescript/promise-function-async -- the server awaits each stage in a `try`, and an `async` stage adds a promise to each request.
		middleware: (context, next) =>
			context.req.method === "POST" && context.req.path === path
				? receive(context)
				: next().then(async () => failed(context)),
	});
}
