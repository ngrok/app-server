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

	it("writes the waiting lines at once on flushLogs", () => {
		const write = spyStdout();

		jsonSink().log("info", "stopped", {});
		flushLogs();

		expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"message":"stopped"'));
	});
});
