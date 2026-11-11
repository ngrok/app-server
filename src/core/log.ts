import type { Context } from "hono";
import type { AppServerEnv, LogSink, RequestLogger } from "./types.js";

/** The standard output (stdout) lines that wait for {@link flushLogs}. */
let pending = "";
/** Whether the process emits `exit`. Then no turn of the event loop follows, so each line goes to stdout at once. */
let exiting = false;

/** The libuv handle of stdout on Node.js. Bun and Deno have none. */
type StdoutHandle = { _handle?: { setBlocking?: (blocking: boolean) => number } };

// Why: a process that crashes or calls `process.exit()` before the next turn keeps its last lines.
process.on("exit", () => {
	exiting = true;
	// Why block: the exit drops a write that waits for a full pipe. On POSIX, a write to a file or
	// a terminal already blocks.
	// oxlint-disable-next-line no-underscore-dangle -- Node.js has no public way to block stdout.
	(process.stdout as NodeJS.WriteStream & StdoutHandle)._handle?.setBlocking?.(true);
	// Why one write for each line: Bun cannot block. Between small writes, the reader can empty the pipe.
	for (const line of pending.match(/[^\n]*\n/gu) ?? []) {
		process.stdout.write(line);
	}
	pending = "";
});

/**
 * Writes the stdout lines of {@link jsonSink} that wait, in one write. Call it
 * before the process exits.
 */
export function flushLogs(): void {
	if (pending === "") {
		return;
	}
	const lines = pending;
	pending = "";
	process.stdout.write(lines);
}

/**
 * Adds `line` to the next stdout write. Why one write for each turn of the
 * event loop: a write to a pipe, such as stdout in Docker, is a system call,
 * and under load many requests end in one turn.
 */
function writeStdout(line: string): void {
	if (exiting) {
		process.stdout.write(line);
		return;
	}
	if (pending === "") {
		setImmediate(flushLogs);
	}
	pending += line;
}

/**
 * A log sink that writes one JSON object per line. Each line has `time`,
 * `level`, `message`, and the flat attributes, which Datadog reads as its
 * standard attributes. The default writes the lines of one event-loop turn
 * to stdout at the end of the turn.
 *
 * @param write - Where each line goes. Defaults to stdout.
 *
 * @example
 * createServer({ logger: jsonSink() });
 * // {"time":"2026-10-28T12:00:00.000Z","level":"info","message":"request","http.status_code":200}
 */
export function jsonSink(write: (line: string) => void = writeStdout): LogSink {
	return {
		log: (level, message, attributes) => {
			write(`${JSON.stringify({ time: isoNow(), level, message, ...attributes })}\n`);
		},
	};
}

/**
 * A log sink that writes one line of `key=value` pairs per event, in the text
 * format of Go's `log/slog`. A value with a space, a quote, `=`, or a control
 * character is quoted, so an escape sequence cannot reach the terminal.
 * `app-server start` uses it, because a person reads those lines.
 *
 * @param write - Where each line goes. Defaults to stdout, at once. Why not
 * one write for each turn: the lines then keep their order with Vite's lines.
 *
 * @example
 * textSink().log("info", "port in use, trying the next port", { "server.port": 3000 });
 * // time=2026-11-11T12:00:00.000Z level=INFO msg="port in use, trying the next port" server.port=3000
 */
export function textSink(
	write: (line: string) => void = (line) => {
		process.stdout.write(line);
	},
): LogSink {
	return {
		log: (level, message, attributes) => {
			let line = `time=${isoNow()} level=${level.toUpperCase()} msg=${textValue(message)}`;
			for (const [key, value] of Object.entries(attributes)) {
				line += ` ${key}=${textValue(value)}`;
			}
			write(`${line}\n`);
		},
	};
}

/** A value of a {@link textSink} line. `JSON.stringify` escapes each control character. */
function textValue(value: unknown): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	return /^[^\s"=\p{Cc}]+$/u.test(text) ? text : JSON.stringify(text);
}

/** The millisecond of the last `time`, and its ISO string. */
let lastMs = Number.NaN;
let lastTime = "";
/** The second of `secondPrefix`, and its ISO string up to the milliseconds, such as `2026-11-03T12:00:00.`. */
let lastSecond = Number.NaN;
let secondPrefix = "";

/**
 * The time now, as `new Date().toISOString()` gives it. Why keep the last
 * time: under load, many lines share a millisecond. Why keep the prefix of
 * the second: `toISOString()` costs more than the rest of a line.
 */
function isoNow(): string {
	const now = Date.now();
	if (now !== lastMs) {
		lastMs = now;
		const second = Math.floor(now / 1000);
		if (second !== lastSecond) {
			lastSecond = second;
			secondPrefix = new Date(now).toISOString().slice(0, -4);
		}
		lastTime = `${secondPrefix}${String(now - second * 1000).padStart(3, "0")}Z`;
	}
	return lastTime;
}

/** Flat `error.*` attributes for a thrown value. */
export function errorAttributes(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return { "error.kind": error.name, "error.message": error.message, "error.stack": error.stack };
	}
	return { "error.message": String(error) };
}

type Attributes = Readonly<Record<string, unknown>>;

/**
 * A logger that writes to `sink`. `withBase` gives the attributes of each
 * line as a new object, from the attributes that the caller gives.
 */
export function sinkLogger(
	sink: LogSink,
	withBase: (attributes: Attributes) => Attributes = (attributes) => ({ ...attributes }),
): RequestLogger {
	// Why four functions in one scope: a function that makes each one adds a scope for each, on each request.
	return {
		debug: (message, attributes = {}) => {
			sink.log("debug", message, withBase(attributes));
		},
		info: (message, attributes = {}) => {
			sink.log("info", message, withBase(attributes));
		},
		warn: (message, attributes = {}) => {
			sink.log("warn", message, withBase(attributes));
		},
		error: (message, attributes = {}) => {
			sink.log("error", message, withBase(attributes));
		},
	};
}

/** A logger whose lines carry the request's ID, method, path, and `logAttributes`. */
export function requestLogger(sink: LogSink, context: Context<AppServerEnv>): RequestLogger {
	// Why read at call time: the `requestId` plugin runs after this logger is made. Why one object:
	// a base object and then a merge copy each attribute two times.
	return sinkLogger(sink, (attributes) => ({
		"http.request_id": context.get("requestId"),
		"http.method": context.req.method,
		"http.url_details.path": context.req.path,
		...context.get("logAttributes"),
		...attributes,
	}));
}
