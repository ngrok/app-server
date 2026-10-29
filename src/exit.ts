import { setTimeout } from "node:timers";

/** How long the exit waits for stdout and stderr. */
const FLUSH_TIMEOUT_MS = 1_000;

/**
 * Exits the process after stdout and stderr write what they hold, so the last
 * log lines are not lost. The exit code is `process.exitCode`, else 0.
 *
 * Why exit at all: when shutdown is done, the server holds nothing open. A
 * timer that the app left, such as the render abort timer in React Router's
 * `entry.server`, would otherwise keep the stopped process alive.
 */
export function exitAfterFlush(): void {
	let pending = 2;
	const done = () => {
		pending -= 1;
		if (pending === 0) {
			process.exit();
		}
	};
	// Why a write: its callback runs after each earlier write. A pipe on macOS writes async.
	process.stdout.write("", done);
	process.stderr.write("", done);
	// Why a fallback: a reader that stops reading the pipe would hold the write callbacks forever.
	setTimeout(() => {
		process.exit();
	}, FLUSH_TIMEOUT_MS).unref();
}
