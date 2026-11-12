import type { Context } from "hono";
import type { AppServerEnv, LogOptions, LogSink, RequestLogger } from "./types.js";

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

/** The end of a {@link jsonSink} line whose attributes have no JSON. */
const NO_JSON = '"log.error":"attributes not written as JSON"}';

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
		log: ({ level, message, attributes }) => {
			const time = isoNow();
			const head = `{"time":"${time}","level":"${level}","message":${JSON.stringify(message)}`;
			// Why the key check: a caller's `time`, `level`, or `message` replaces the sink's, as in a spread.
			const ownKeys = "time" in attributes || "level" in attributes || "message" in attributes;
			// Why a splice, not one object: a copy of each attribute costs more than the rest of the line.
			const json = toJson(ownKeys ? { time, level, message, ...attributes } : attributes);
			let line = `${head},${NO_JSON}`;
			if (json != null) {
				line = ownKeys ? json : `${head}${json === "{}" ? "}" : `,${json.slice(1)}`}`;
			}
			write(`${line}\n`);
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
 * textSink().log({ level: "info", message: "port in use, trying the next port", attributes: { "server.port": 3000 } });
 * // time=2026-11-11T12:00:00.000Z level=INFO msg="port in use, trying the next port" server.port=3000
 */
export function textSink(
	write: (line: string) => void = (line) => {
		process.stdout.write(line);
	},
): LogSink {
	return {
		log: ({ level, message, attributes }) => {
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
	if (typeof value === "bigint") {
		return `${value}n`;
	}
	const text = typeof value === "string" ? value : (toJson(value) ?? String(value));
	return /^[^\s"=\p{Cc}]+$/u.test(text) ? text : JSON.stringify(text);
}

/**
 * `value` as JSON, with each bigint as a string such as `"1n"`, and each
 * cycle as `"[Circular]"`. Gives `undefined` for a value with no JSON, such
 * as a function, or one whose `toJSON` throws. Why try the plain call first:
 * the replacer runs for each value, and a log line seldom needs it.
 */
function toJson(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		try {
			return JSON.stringify(value, safeReplacer());
		} catch {
			return undefined;
		}
	}
}

/** A `JSON.stringify` replacer for {@link toJson}. */
function safeReplacer(): (this: unknown, key: string, value: unknown) => unknown {
	// Why the ancestors, not each object seen: an object that two fields share is not a cycle.
	const ancestors: unknown[] = [];
	return function replace(this: unknown, _key: string, value: unknown): unknown {
		if (typeof value === "bigint") {
			return `${value}n`;
		}
		if (typeof value !== "object" || value == null) {
			return value;
		}
		// Why `this`: it is the object that holds `value`, so each ancestor after it is done.
		while (ancestors.length > 0 && ancestors.at(-1) !== this) {
			ancestors.pop();
		}
		if (ancestors.includes(value)) {
			return "[Circular]";
		}
		ancestors.push(value);
		return value;
	};
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

type Attributes = Readonly<Record<string, unknown>>;

/**
 * A thrown value as an `Error`, so a log line gives it the `error.*` fields.
 * Hono sends only an `Error` to `onError`, and rethrows any other value.
 */
export function asError(error: unknown): Error {
	return error instanceof Error
		? error
		: new Error(`A non-Error value was thrown: ${String(error)}`, { cause: error });
}

/**
 * The fields of an error that {@link errorFields} writes on its own, not as an
 * own field. Why `kind`: an own `kind` must not replace the error's name.
 */
const ERROR_KEYS = new Set(["name", "kind", "message", "stack", "cause"]);

/**
 * The dotted fields of `error` under `prefix`: `kind`, `message`, `stack`,
 * each own field, such as `code`, the `cause` chain, and the `errors` of an
 * `AggregateError`. An error with `toJSON` gives its own fields from it. An
 * error that is its own ancestor in the chain gives `"[Circular]"`.
 *
 * @example
 * errorFields(new Error("no row", { cause: new RangeError("bad id") }), "error");
 * // => { "error.kind": "Error", "error.message": "no row", "error.stack": "…",
 * //      "error.cause.kind": "RangeError", "error.cause.message": "bad id", "error.cause.stack": "…" }
 */
function errorFields(error: Error, prefix: string): Record<string, unknown> {
	// Why the ancestors, not each error seen: an error that two fields share is not a cycle.
	const ancestors: Error[] = [];
	const addError = (fields: Record<string, unknown>, base: string, current: Error): void => {
		const at = (key: string) => (base === "" ? key : `${base}.${key}`);
		const add = (key: string, value: unknown) => {
			if (!(value instanceof Error)) {
				fields[key] = value;
			} else if (ancestors.includes(value)) {
				fields[key] = "[Circular]";
			} else {
				addError(fields, key, value);
			}
		};
		ancestors.push(current);
		fields[at("kind")] = current.name;
		fields[at("message")] = current.message;
		fields[at("stack")] = current.stack;
		const toJSON: unknown = "toJSON" in current ? current.toJSON : undefined;
		const own: unknown =
			typeof toJSON === "function" ? Reflect.apply(toJSON, current, []) : current;
		if (typeof own === "object" && own != null) {
			for (const [key, value] of Object.entries(own)) {
				if (!ERROR_KEYS.has(key)) {
					add(at(key), value);
				}
			}
		}
		if (current.cause != null) {
			add(at("cause"), current.cause);
		}
		if (current instanceof AggregateError) {
			fields[at("errors")] = current.errors.map((member: unknown) => {
				if (!(member instanceof Error)) {
					return member;
				}
				if (ancestors.includes(member)) {
					return "[Circular]";
				}
				const memberFields: Record<string, unknown> = {};
				addError(memberFields, "", member);
				return memberFields;
			});
		}
		ancestors.pop();
	};
	const fields: Record<string, unknown> = {};
	addError(fields, prefix, error);
	return fields;
}

/**
 * `attributes` with each `Error` value replaced by its fields, after the
 * `change` hook. Each other attribute, such as `http.method`, wins over an
 * error field of the same name.
 */
function flattenErrors(attributes: Attributes, change: LogOptions["error"]): Attributes {
	// Why look first: a line seldom holds an error, and then it needs no copy. Why `for...in`: it
	// makes no array, and costs about half of `Object.values(...).some(...)` for each line.
	let hasError = false;
	for (const key in attributes) {
		if (attributes[key] instanceof Error) {
			hasError = true;
			break;
		}
	}
	if (!hasError) {
		return attributes;
	}
	const flat: Record<string, unknown> = {};
	// Why `Object.entries`: it gives only own fields, and both passes must read the same fields.
	const entries = Object.entries(attributes);
	for (const [key, value] of entries) {
		if (value instanceof Error) {
			const fields = errorFields(value, key);
			Object.assign(flat, change == null ? fields : change({ error: value, prefix: key, fields }));
		} else {
			flat[key] = value;
		}
	}
	// Why write them again: an error field that comes later must not replace an attribute, such as
	// a request field. A key keeps its first place.
	for (const [key, value] of entries) {
		if (!(value instanceof Error)) {
			flat[key] = value;
		}
	}
	return flat;
}

/**
 * A sink that writes each line to `sink`, after it replaces each `Error`
 * value with its fields, and then runs the `attributes` hook.
 *
 * @example
 * hookSink(jsonSink()).log({ level: "error", message: "failed", attributes: { error: new Error("boom") } });
 * // {"time":"…","level":"error","message":"failed","error.kind":"Error","error.message":"boom","error.stack":"…"}
 */
export function hookSink(
	sink: LogSink,
	{ attributes: changeAttributes, error: changeError }: LogOptions = {},
): LogSink {
	return {
		log: (line) => {
			const flat = flattenErrors(line.attributes, changeError);
			// Why keep `line` when nothing changes: a line seldom holds an error, and then it needs no copy.
			const flatLine = flat === line.attributes ? line : { ...line, attributes: flat };
			sink.log(
				changeAttributes == null
					? flatLine
					: { ...flatLine, attributes: changeAttributes(flatLine) },
			);
		},
	};
}

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
			sink.log({ level: "debug", message, attributes: withBase(attributes) });
		},
		info: (message, attributes = {}) => {
			sink.log({ level: "info", message, attributes: withBase(attributes) });
		},
		warn: (message, attributes = {}) => {
			sink.log({ level: "warn", message, attributes: withBase(attributes) });
		},
		error: (message, attributes = {}) => {
			sink.log({ level: "error", message, attributes: withBase(attributes) });
		},
	};
}

/**
 * A logger whose lines carry the request's ID, method, path, and
 * `logAttributes`. These fields win over a caller's field of the same name.
 */
export function requestLogger(sink: LogSink, context: Context<AppServerEnv>): RequestLogger {
	// Why read at call time: the `requestId` plugin runs after this logger is made.
	return sinkLogger(sink, (attributes) => {
		const requestId = context.get("requestId");
		const { method, path } = context.req;
		const logAttributes = context.get("logAttributes");
		const line: Record<string, unknown> = {
			"http.request_id": requestId,
			"http.method": method,
			"http.url_details.path": path,
			...logAttributes,
			...attributes,
		};
		// Why write them again, not merge a base object: a caller's field must not replace a request
		// field, and a merge copies each attribute two times. A key keeps its first place.
		// oxlint-disable-next-line unicorn/no-immediate-mutation -- the spread above must not win.
		line["http.request_id"] = requestId;
		line["http.method"] = method;
		line["http.url_details.path"] = path;
		Object.assign(line, logAttributes);
		return line;
	});
}
