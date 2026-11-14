import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "hono";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { hookSink, jsonSink, requestLogger, textSink } from "./log.js";
import { accessLog } from "./plugins/access-log.js";
import { testServer } from "../test-server.js";
import type { AppServerEnv, LogSink } from "./types.js";

describe("the core", () => {
	it("loads and logs on a runtime with no `process` global, such as a host that is not Node.js", () => {
		// Why the hook: Node.js runs a `.ts` file, but it does not find one for a `.js` import.
		const script = `
			import { registerHooks } from "node:module";
			registerHooks({
				resolve(specifier, context, nextResolve) {
					try {
						return nextResolve(specifier, context);
					} catch (error) {
						if (!specifier.endsWith(".js")) throw error;
						return nextResolve(specifier.slice(0, -3) + ".ts", context);
					}
				},
			});
			const write = process.stdout.write.bind(process.stdout);
			const lines = [];
			console.log = (line) => lines.push(JSON.parse(line).message);
			delete globalThis.process;
			const core = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "index.ts")).href)});
			core.logger().info("hello");
			write(JSON.stringify({ process: typeof globalThis.process, lines }));
		`;

		const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
			encoding: "utf8",
		});

		expect(JSON.parse(stdout)).toStrictEqual({ process: "undefined", lines: ["hello"] });
	});
});

describe("jsonSink", () => {
	it("gives each line to console.log, with no newline, when no host gave a log writer", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		onTestFinished(() => {
			log.mockRestore();
		});

		jsonSink().log({ level: "info", message: "first", attributes: {} });
		jsonSink().log({ level: "warn", message: "second", attributes: { "http.status_code": 500 } });

		expect(log.mock.calls.map(([line]): unknown => JSON.parse(String(line)))).toStrictEqual([
			{ time: expect.any(String), level: "info", message: "first" },
			{ time: expect.any(String), level: "warn", message: "second", "http.status_code": 500 },
		]);
		expect(log.mock.calls.every(([line]) => !String(line).includes("\n"))).toBe(true);
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

		sink.log({
			level: "warn",
			message: "slow",
			attributes: { "http.status_code": 200, duration: 5, "http.useragent": undefined },
		});

		expect(lines).toStrictEqual([
			'{"time":"2026-11-03T12:00:00.000Z","level":"warn","message":"slow","http.status_code":200,"duration":5}\n',
		]);
	});

	it("lets a caller's time, level, or message replace the sink's, and writes each key once", () => {
		const lines: string[] = [];
		const sink = jsonSink((line) => {
			lines.push(line);
		});

		sink.log({
			level: "info",
			message: "request",
			attributes: { message: "custom", "http.status_code": 200 },
		});

		expect(lines).toStrictEqual([
			expect.stringMatching(
				/^\{"time":"[^"]+","level":"info","message":"custom","http\.status_code":200\}\n$/u,
			),
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

		sink.log({ level: "info", message: "first", attributes: {} });
		sink.log({ level: "info", message: "same millisecond", attributes: {} });
		vi.setSystemTime(Date.UTC(2026, 10, 3, 12, 0, 0, 1));
		sink.log({ level: "info", message: "next millisecond", attributes: {} });
		vi.setSystemTime(Date.UTC(2026, 10, 3, 11, 59, 59, 999));
		sink.log({ level: "info", message: "clock set back", attributes: {} });

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

		sink.log({
			level: "info",
			message: "values",
			attributes: { count: 1n, parent, a: shared, b: shared },
		});
		sink.log({
			level: "info",
			message: "bad toJSON",
			attributes: {
				value: {
					toJSON: () => {
						throw new Error("no JSON");
					},
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

		sink.log({
			level: "info",
			message: "port in use, trying the next port",
			attributes: { "server.port": 3000 },
		});
		sink.log({
			level: "error",
			message: "failed",
			attributes: { "error.message": 'a "quote"\nand a line', ok: true, empty: "" },
		});
		sink.log({ level: "error", message: "failed", attributes: { "error.message": "\u001B[2J" } });

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

	it("writes no field for undefined, as jsonSink does, and writes null", () => {
		const lines: string[] = [];

		textSink((line) => {
			lines.push(line);
		}).log({
			level: "info",
			message: "request",
			attributes: { "http.referer": undefined, "usr.id": null, "http.status_code": 200 },
		});

		expect(lines).toStrictEqual([
			expect.stringMatching(/ msg=request usr\.id=null http\.status_code=200\n$/u),
		]);
	});

	it("writes a bigint as a string", () => {
		const lines: string[] = [];

		textSink((line) => {
			lines.push(line);
		}).log({ level: "info", message: "count", attributes: { count: 1n, counts: [2n] } });

		expect(lines).toStrictEqual([expect.stringMatching(/ count=1n counts="\[\\"2n\\"\]"\n$/u)]);
	});
});

/** A sink that keeps the attributes of each line. */
function recordingSink(): { sink: LogSink; lines: Readonly<Record<string, unknown>>[] } {
	const lines: Readonly<Record<string, unknown>>[] = [];
	return {
		sink: {
			log: ({ attributes }) => {
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

		hookSink(sink).log({
			level: "error",
			message: "failed",
			attributes: { "usr.id": "user-1", "db.error": error, ok: false },
		});

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

		hookSink(sink).log({
			level: "error",
			message: "failed",
			attributes: { error: aggregate, other: loop },
		});

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

		hookSink(sink).log({ level: "error", message: "failed", attributes: { error } });

		expect(lines[0]).toStrictEqual({
			"error.kind": "Error",
			"error.message": "denied",
			"error.stack": error.stack,
			"error.status": 403,
		});
	});

	it("gives the error hook the default fields, and writes the fields that it gives", () => {
		const { sink, lines } = recordingSink();
		const error = Object.assign(new Error("unavailable"), { "rpc.service": "svc.Users" });
		const hooked = hookSink(sink, {
			error: ({ prefix, fields: { [`${prefix}.rpc.service`]: service, ...fields } }) => ({
				...fields,
				"rpc.service": service,
			}),
		});

		hooked.log({ level: "error", message: "failed", attributes: { error } });

		expect(lines).toStrictEqual([
			{
				"error.kind": "Error",
				"error.message": "unavailable",
				"error.stack": error.stack,
				"rpc.service": "svc.Users",
			},
		]);
	});

	it("gives the line to the error and attributes hooks", () => {
		const { sink, lines } = recordingSink();
		const hooked = hookSink(sink, {
			error: ({ error, prefix }) => ({ [`${prefix}.kind`]: error.name }),
			attributes: ({ level, message, attributes }) => ({
				...attributes,
				"usr.email": "REDACTED",
				line: `${level} ${message}`,
			}),
		});

		hooked.log({
			level: "warn",
			message: "slow",
			attributes: { error: new TypeError("boom"), "usr.email": "a@example.com" },
		});

		expect(lines).toStrictEqual([
			{ "error.kind": "TypeError", "usr.email": "REDACTED", line: "warn slow" },
		]);
	});

	it("keeps the error's name as kind when the error has an own kind", () => {
		const { sink, lines } = recordingSink();
		const error = Object.assign(new Error("boom"), { kind: "BizRuleViolation" });

		hookSink(sink).log({ level: "error", message: "failed", attributes: { error } });

		expect(lines[0]).toStrictEqual({
			"error.kind": "Error",
			"error.message": "boom",
			"error.stack": error.stack,
		});
	});

	it("keeps each attribute when an error field has the same name", () => {
		const { sink, lines } = recordingSink();
		const error = Object.assign(new Error("upstream"), { "http.method": "POST" });
		const hooked = hookSink(sink, {
			error: ({ prefix, fields: { [`${prefix}.http.method`]: method, ...fields } }) => ({
				...fields,
				"http.method": method,
			}),
		});

		hooked.log({
			level: "error",
			message: "failed",
			attributes: { "http.method": "GET", error },
		});

		expect(Object.entries(lines[0] ?? {})).toStrictEqual([
			["http.method", "GET"],
			["error.kind", "Error"],
			["error.message", "upstream"],
			["error.stack", error.stack],
		]);
	});

	it("writes no inherited attribute when the line has an error", () => {
		const { sink, lines } = recordingSink();
		const error = new TypeError("boom");
		const attributes = Object.assign(
			Object.create({ "error.kind": "fake", "http.method": "GET" }),
			{
				error,
			},
		);

		hookSink(sink).log({ level: "error", message: "failed", attributes });

		expect(lines[0]).toStrictEqual({
			"error.kind": "TypeError",
			"error.message": "boom",
			"error.stack": error.stack,
		});
	});

	it("passes a line with no error on as it is", () => {
		const { sink, lines } = recordingSink();
		const attributes = { "http.status_code": 200 };

		hookSink(sink).log({ level: "info", message: "request", attributes });

		expect(lines[0]).toBe(attributes);
	});
});

describe("a log hook that throws", () => {
	it("answers 500 for a route that throws, and writes log.error in place of the error fields", async () => {
		const { request, lines } = await testServer({
			plugins: [accessLog()],
			options: {
				log: {
					error: () => {
						throw new TypeError("no code");
					},
				},
			},
			render: async () => {
				throw new Error("the database is down");
			},
		});

		const response = await request("/boom");

		expect(response.status).toBe(500);
		await expect(response.text()).resolves.toBe("Internal Server Error");
		expect(lines).toStrictEqual([
			{
				level: "error",
				message: "unhandled error",
				attributes: {
					"http.request_id": undefined,
					"http.method": "GET",
					"http.url_details.path": "/boom",
					"log.error": "the error hook of the log option threw: no code",
				},
			},
			{
				level: "error",
				message: "request",
				attributes: expect.objectContaining({ "http.status_code": 500 }),
			},
		]);
	});

	it("answers the request, and writes log.error in place of the attributes of each line", async () => {
		const { request, lines } = await testServer({
			plugins: [accessLog()],
			options: {
				log: {
					attributes: () => {
						throw new TypeError("no referer");
					},
				},
			},
			routes: (app) => {
				app.get("/logs", (context) => {
					context.get("logger").info("loading", { "usr.email": "a@example.com" });
					return context.text("ok");
				});
			},
		});

		const response = await request("/logs");

		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("ok");
		const attributes = {
			"log.error": "the attributes hook of the log option threw: no referer",
		};
		expect(lines).toStrictEqual([
			{ level: "info", message: "loading", attributes },
			{ level: "info", message: "request", attributes },
		]);
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
