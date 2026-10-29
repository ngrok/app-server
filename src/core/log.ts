import type { Context } from "hono";
import type { AppServerEnv, LogSink, RequestLogger } from "./types.js";

/**
 * A log sink that writes one JSON object per line. Each line has `time`,
 * `level`, `message`, and the flat attributes, which Datadog reads as its
 * standard attributes.
 *
 * @param write - Where each line goes. Defaults to stdout.
 *
 * @example
 * createServer({ logger: jsonSink() });
 * // {"time":"2026-10-28T12:00:00.000Z","level":"info","message":"request","http.status_code":200}
 */
export function jsonSink(
	write: (line: string) => void = (line) => {
		process.stdout.write(line);
	},
): LogSink {
	return {
		log: (level, message, attributes) => {
			write(
				`${JSON.stringify({ time: new Date().toISOString(), level, message, ...attributes })}\n`,
			);
		},
	};
}

/** Flat `error.*` attributes for a thrown value. */
export function errorAttributes(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return { "error.kind": error.name, "error.message": error.message, "error.stack": error.stack };
	}
	return { "error.message": String(error) };
}

/** A logger that writes to `sink`, with the attributes from `base` first on each line. */
export function sinkLogger(
	sink: LogSink,
	base: () => Readonly<Record<string, unknown>> = () => ({}),
): RequestLogger {
	const line =
		(level: "debug" | "info" | "warn" | "error") =>
		(message: string, attributes: Readonly<Record<string, unknown>> = {}) => {
			sink.log(level, message, { ...base(), ...attributes });
		};
	return { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error") };
}

/** A logger whose lines carry the request's ID, method, and path. */
export function requestLogger(sink: LogSink, context: Context<AppServerEnv>): RequestLogger {
	// Why read at call time: the `requestId` plugin runs after this logger is made.
	return sinkLogger(sink, () => ({
		"http.request_id": context.get("requestId"),
		"http.method": context.req.method,
		"http.url_details.path": context.req.path,
	}));
}
