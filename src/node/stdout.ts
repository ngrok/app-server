import { setImmediate } from "node:timers";
import type { HostRuntime } from "../core/types.js";

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
 * Writes the stdout lines of {@link logWriter} that wait, in one write. Call
 * it before the process exits.
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
 * The log writer of a host on Node.js, Bun, or Deno. It writes the lines of
 * one event-loop turn to stdout in one write, at the end of the turn. Each
 * line still reaches stdout when the process exits before that.
 *
 * @example
 * export const host: HostRuntime = { files: nodeFiles, logWriter };
 */
export const logWriter: NonNullable<HostRuntime["logWriter"]> = {
	write: writeStdout,
	flush: flushLogs,
};
