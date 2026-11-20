import type { Context } from "hono";
import { checkCount } from "../check-count.js";
import {
	CLIENT_ERROR_SOURCES,
	CLIENT_ERRORS_PATH,
	MAX_REPORT_BYTES,
} from "../client-error-report.js";
import type { ClientErrorReport, ClientErrorSource } from "../client-error-report.js";
import { asError } from "../log.js";
import { checkRequestPath, optionPlugin } from "../plugin-options.js";
import { settlesWithin } from "../settles-within.js";
import type { AppServerEnv, Plugin, RequestLogger } from "../types.js";

/** One frame of the stack of a {@link ClientErrorEvent}. */
export type ClientErrorFrame = {
	/** The function name, when the browser gave one. */
	function: string | undefined;
	/** The URL of the script, such as `https://example.com/assets/home-3f9a1c.js`. */
	file: string;
	line: number;
	column: number;
};

/** One error of the client code, as the `filter` and the `sink` of {@link clientErrors} get it. */
export type ClientErrorEvent = {
	/** The name of the error, such as `TypeError`. */
	name: string;
	message: string;
	/** The frames of the stack, from the frame that threw. It has one frame or more. */
	frames: readonly ClientErrorFrame[];
	source: ClientErrorSource;
	/** The route pattern, such as `/domains/:domainId`, when the router gave one. */
	route: string | undefined;
	/** The pathname of the page, with no query and no fragment. */
	path: string;
	userAgent: string;
	/** The build that the page runs, when `buildId()` sent one. It can be older than the build of the server. */
	buildId: string | undefined;
};

/** Options for {@link clientErrors}. */
export type ClientErrorsOptions = {
	/**
	 * The path of the endpoint. Give the same path to the client module. It
	 * must start with `/`.
	 * @default "/_app/issues"
	 */
	path?: string;
	/**
	 * Takes each event, such as to send it to an error tracker. The server
	 * waits for it for 3 seconds at most before it answers, so a serverless
	 * host does not stop it. A sink that throws or rejects logs one error line.
	 * @default one `client error` line of the request's logger, with the level `error`
	 */
	sink?: (event: ClientErrorEvent) => void | Promise<void>;
	/** Whether the sink gets an event. Give `false` for noise that the app knows. */
	filter?: (event: ClientErrorEvent) => boolean;
	/**
	 * How many reports this process takes in one minute. Each report after
	 * them gets a 429. `0` takes none.
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
 * of Chromium, each with or without `async`, and `name@file:1:2` and
 * `file:1:2` of Firefox and Safari. A line that is not a frame, such as the
 * message, gives `undefined`.
 *
 * Why no single pattern: a client writes the stack, and a pattern with an
 * optional name takes quadratic time on a long line that is not a frame.
 */
function frameOf(line: string): ClientErrorFrame | undefined {
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
function framesOf(stack: string): ClientErrorFrame[] {
	const frames: ClientErrorFrame[] = [];
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
 */
function isSameOrigin(context: Context<AppServerEnv>): boolean {
	const site = context.req.header("Sec-Fetch-Site");
	if (site != null) {
		return site === "same-origin";
	}
	const origin = URL.parse(context.req.header("Origin") ?? "");
	return origin != null && origin.host === new URL(context.req.url).host;
}

/** An answer with no body. */
function empty(status: 204 | 400 | 403 | 413 | 429): Response {
	return new Response(null, { status });
}

/** The default sink: one error line. Why an `Error`: the `log` hooks of `createServer` then get it. */
function logEvent(logger: RequestLogger, event: ClientErrorEvent): void {
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
 * Takes the reports of the errors of the client code and gives each one to a
 * sink, so an app sees a broken page with no vendor script in the browser.
 * The client module of `@ngrok/app-server/client`, such as
 * `clientErrorsReactRouter()`, sends the reports as a `POST` to `path`.
 *
 * The plugin answers before the framework runs. A report gets a 204 when the
 * plugin takes it or drops it, and:
 *
 * - a 403 from a page of another origin,
 * - a 413 for a body of more than 16 KiB,
 * - a 400 for a body that is not a report,
 * - a 429 after `maxPerMinute` reports in one minute.
 *
 * The plugin drops a report from a bot, and one whose stack has no frame. In
 * production, it also drops one whose first frame is not a file of Vite's
 * `build.assetsDir`, such as an inline script that a browser extension adds.
 * Then the `filter` decides, and the `sink` gets the event.
 *
 * The limit counts in the memory of one process. On a serverless host, each
 * instance has its own count, so the limit of the sink's service is the hard
 * limit there. A `path` that does not start with `/`, or a `maxPerMinute`
 * that is not a whole number of 0 or more, stops startup.
 *
 * @example
 * createServer({
 * 	plugins: defaultPlugins({
 * 		clientErrors: {
 * 			filter: (event) => !event.message.includes("AbortError"),
 * 			sink: async (event) => {
 * 				await fetch("https://errors.example.com/events", { method: "POST", body: JSON.stringify(event) });
 * 			},
 * 		},
 * 	}),
 * });
 */
export function clientErrors({
	path = CLIENT_ERRORS_PATH,
	sink,
	filter,
	maxPerMinute = 60,
}: ClientErrorsOptions = {}): Plugin {
	checkRequestPath({ plugin: "clientErrors", option: "path", path });
	checkCount("The maxPerMinute of clientErrors", maxPerMinute);
	/** In development, each file is an app file: Vite serves source modules from many paths. */
	let assetsPath = "/";
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
	const receive = async (context: Context<AppServerEnv>): Promise<Response> => {
		if (!isSameOrigin(context)) {
			return empty(403);
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
		if (isOverLimit()) {
			return empty(429);
		}
		const frames = framesOf(report.stack);
		const event: ClientErrorEvent = {
			name: report.name,
			message: report.message,
			frames,
			source: report.source,
			route: report.route,
			path: report.path,
			userAgent,
			buildId: report.build,
		};
		if (
			URL.parse(frames[0]?.file ?? "")?.pathname.startsWith(assetsPath) !== true ||
			filter?.(event) === false
		) {
			return empty(204);
		}
		const logger = context.get("logger");
		if (sink == null) {
			logEvent(logger, event);
			return empty(204);
		}
		// Why wait: a serverless host can stop the function when it answers.
		const sent = (async () => {
			try {
				await sink(event);
			} catch (error) {
				logger.error("client error sink failed", { error: asError(error) });
			}
		})();
		if (!(await settlesWithin(sent, SINK_DEADLINE_MS))) {
			logger.warn("client error sink passed the deadline", {
				"app_server.deadline_ms": SINK_DEADLINE_MS,
			});
		}
		return empty(204);
	};
	return optionPlugin("clientErrors", {
		name: "client-errors",
		setup: (info) => {
			if (info.mode === "production") {
				({ assetsPath } = info);
			}
		},
		// oxlint-disable-next-line typescript/promise-function-async -- the server awaits each stage in a `try`, and an `async` stage adds a promise to each request.
		middleware: (context, next) =>
			context.req.method === "POST" && context.req.path === path ? receive(context) : next(),
	});
}
