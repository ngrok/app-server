import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { flushLogs, jsonSink } from "./log.js";

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
});
