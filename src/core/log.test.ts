import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "hono";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { flushLogs, hookSink, jsonSink, requestLogger, textSink } from "./log.js";
import type { AppServerEnv, LogSink } from "./types.js";

/** A spy on stdout that keeps each write out of the test output. */
function spyStdout() {
	const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	onTestFinished(() => {
		write.mockRestore();
	});
	return write;
}

describe("jsonSink", () => {
	it("writes the lines of one event-loop turn to stdout in one write", async () => {
		const write = spyStdout();
		const sink = jsonSink();

		sink.log("info", "first", {});
		sink.log("warn", "second", { "http.status_code": 500 });
		expect(write).not.toHaveBeenCalled();
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});

		expect(write).toHaveBeenCalledTimes(1);
		const lines = String(write.mock.calls[0]?.[0]).split("\n");
		expect(lines.map((line): unknown => (line === "" ? line : JSON.parse(line)))).toStrictEqual([
			{ time: expect.any(String), level: "info", message: "first" },
			{ time: expect.any(String), level: "warn", message: "second", "http.status_code": 500 },
			"",
		]);
	});

	it("writes each line to a pipe when the process exits before the next turn", () => {
		// Why 1,000 lines: they hold more bytes than the 64 KiB of a pipe, so one write to it waits in a queue.
		const script = `
			import { jsonSink } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "log.ts")).href)};
			const sink = jsonSink();
			for (let line = 0; line < 1000; line += 1) sink.log("info", "line", { line });
			process.on("exit", () => sink.log("info", "exiting", {}));
			process.exit();
		`;

		const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
			encoding: "utf8",
		});

		const lines = stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(1001);
		expect(JSON.parse(lines.at(-1) ?? "")).toMatchObject({ message: "exiting" });
	});

	it("writes the waiting lines at once on flushLogs", () => {
		const write = spyStdout();

		jsonSink().log("info", "stopped", {});
		flushLogs();

		expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"message":"stopped"'));
	});

	it("writes the time, the level, the message, and then each attribute in its order", () => {
		vi.useFakeTimers({ now: Date.UTC(2026, 10, 3, 12, 0, 0, 0), toFake: ["Date"] });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const lines: string[] = [];
		const sink = jsonSink((line) => {
			lines.push(line);
		});

		sink.log("warn", "slow", { "http.status_code": 200, duration: 5, "http.useragent": undefined });

		expect(lines).toStrictEqual([
			'{"time":"2026-11-03T12:00:00.000Z","level":"warn","message":"slow","http.status_code":200,"duration":5}\n',
		]);
	});

	it("gives each line the time of its own millisecond", () => {
		vi.useFakeTimers({ now: Date.UTC(2026, 10, 3, 12, 0, 0, 0), toFake: ["Date"] });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const times: unknown[] = [];
		const sink = jsonSink((line) => {
			times.push((JSON.parse(line) as { time: unknown }).time);
		});

		sink.log("info", "first", {});
		sink.log("info", "same millisecond", {});
		vi.setSystemTime(Date.UTC(2026, 10, 3, 12, 0, 0, 1));
		sink.log("info", "next millisecond", {});
		vi.setSystemTime(Date.UTC(2026, 10, 3, 11, 59, 59, 999));
		sink.log("info", "clock set back", {});

		expect(times).toStrictEqual([
			"2026-11-03T12:00:00.000Z",
			"2026-11-03T12:00:00.000Z",
			"2026-11-03T12:00:00.001Z",
			"2026-11-03T11:59:59.999Z",
		]);
	});

	it("writes a bigint as a string and a cycle as [Circular], and does not throw", () => {
		const lines: string[] = [];
		const sink = jsonSink((line) => {
			lines.push(line);
		});
		const parent: Record<string, unknown> = { name: "parent" };
		parent.self = parent;
		const shared = { id: 1 };

		sink.log("info", "values", { count: 1n, parent, a: shared, b: shared });
		sink.log("info", "bad toJSON", {
			value: {
				toJSON: () => {
					throw new Error("no JSON");
				},
			},
		});

		expect(lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
			expect.objectContaining({
				count: "1n",
				parent: { name: "parent", self: "[Circular]" },
				a: { id: 1 },
				b: { id: 1 },
			}),
			{
				time: expect.any(String),
				level: "info",
				message: "bad toJSON",
				"log.error": "attributes not written as JSON",
			},
		]);
	});
});

describe("textSink", () => {
	it("writes the text format of Go's log/slog, and quotes a value only when it must", () => {
		const lines: string[] = [];
		const sink = textSink((line) => {
			lines.push(line);
		});

		sink.log("info", "port in use, trying the next port", { "server.port": 3000 });
		sink.log("error", "failed", { "error.message": 'a "quote"\nand a line', ok: true, empty: "" });
		sink.log("error", "failed", { "error.message": "\u001B[2J" });

		expect(lines).toStrictEqual([
			expect.stringMatching(
				/^time=\S+Z level=INFO msg="port in use, trying the next port" server\.port=3000\n$/u,
			),
			expect.stringMatching(
				/ level=ERROR msg=failed error\.message="a \\"quote\\"\\nand a line" ok=true empty=""\n$/u,
			),
			expect.stringMatching(/ error\.message="\\u001b\[2J"\n$/u),
		]);
	});

	it("writes a bigint as a string", () => {
		const lines: string[] = [];

		textSink((line) => {
			lines.push(line);
		}).log("info", "count", { count: 1n, counts: [2n] });

		expect(lines).toStrictEqual([expect.stringMatching(/ count=1n counts="\[\\"2n\\"\]"\n$/u)]);
	});
});

/** A sink that keeps the attributes of each line. */
function recordingSink(): { sink: LogSink; lines: Readonly<Record<string, unknown>>[] } {
	const lines: Readonly<Record<string, unknown>>[] = [];
	return {
		sink: {
			log: (_level, _message, attributes) => {
				lines.push(attributes);
			},
		},
		lines,
	};
}

describe("hookSink", () => {
	it("writes an error value as dotted fields, with its own fields and its cause chain", () => {
		const { sink, lines } = recordingSink();
		const cause = Object.assign(new RangeError("bad id"), {
			code: "E_ID",
			count: 1n,
			errors: ["id"],
		});
		const error = new Error("no row", { cause });

		hookSink(sink).log("error", "failed", { "usr.id": "user-1", "db.error": error, ok: false });

		expect(lines).toStrictEqual([
			{
				"usr.id": "user-1",
				"db.error.kind": "Error",
				"db.error.message": "no row",
				"db.error.stack": error.stack,
				"db.error.cause.kind": "RangeError",
				"db.error.cause.message": "bad id",
				"db.error.cause.stack": cause.stack,
				"db.error.cause.code": "E_ID",
				"db.error.cause.count": 1n,
				"db.error.cause.errors": ["id"],
				ok: false,
			},
		]);
	});

	it("writes a cause that is not an error, the members of an AggregateError, and a cycle", () => {
		const { sink, lines } = recordingSink();
		const first = new TypeError("first");
		const aggregate = new AggregateError([first, "second"], "all failed", { cause: 1n });
		const loop = new Error("loop");
		loop.cause = loop;

		hookSink(sink).log("error", "failed", { error: aggregate, other: loop });

		expect(lines).toStrictEqual([
			{
				"error.kind": "AggregateError",
				"error.message": "all failed",
				"error.stack": aggregate.stack,
				"error.cause": 1n,
				"error.errors": [{ kind: "TypeError", message: "first", stack: first.stack }, "second"],
				"other.kind": "Error",
				"other.message": "loop",
				"other.stack": loop.stack,
				"other.cause": "[Circular]",
			},
		]);
	});

	it("takes the own fields of an error from its toJSON", () => {
		const { sink, lines } = recordingSink();
		const error = Object.assign(new Error("denied"), {
			token: "secret",
			toJSON: () => ({ status: 403 }),
		});

		hookSink(sink).log("error", "failed", { error });

		expect(lines[0]).toStrictEqual({
			"error.kind": "Error",
			"error.message": "denied",
			"error.stack": error.stack,
			"error.status": 403,
		});
	});

	it("gives the line to the error and attributes hooks", () => {
		const { sink, lines } = recordingSink();
		const hooked = hookSink(sink, {
			error: (error, prefix) => ({ [`${prefix}.kind`]: error.name }),
			attributes: (level, message, attributes) => ({
				...attributes,
				"usr.email": "REDACTED",
				line: `${level} ${message}`,
			}),
		});

		hooked.log("warn", "slow", { error: new TypeError("boom"), "usr.email": "a@example.com" });

		expect(lines).toStrictEqual([
			{ "error.kind": "TypeError", "usr.email": "REDACTED", line: "warn slow" },
		]);
	});

	it("passes a line with no error on as it is", () => {
		const { sink, lines } = recordingSink();
		const attributes = { "http.status_code": 200 };

		hookSink(sink).log("info", "request", attributes);

		expect(lines[0]).toBe(attributes);
	});
});

describe("requestLogger", () => {
	it("puts the request fields first, and keeps them when the caller gives the same names", () => {
		const { sink, lines } = recordingSink();
		const context = new Context<AppServerEnv>(new Request("http://localhost/"));
		context.set("requestId", "abc-123");
		context.set("logAttributes", { trace_id: "trace" });

		requestLogger(sink, context).info("loading", {
			"usr.id": "user-1",
			"http.request_id": "other",
			"http.method": "POST",
			"http.url_details.path": "/other",
			trace_id: "other",
		});

		expect(Object.entries(lines[0] ?? {})).toStrictEqual([
			["http.request_id", "abc-123"],
			["http.method", "GET"],
			["http.url_details.path", "/"],
			["trace_id", "trace"],
			["usr.id", "user-1"],
		]);
	});
});
