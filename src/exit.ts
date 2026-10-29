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
			// oxlint-disable-next-line unicorn/no-process-exit -- this function exists to end the process.
			process.exit();
		}
	};
	flush(process.stdout, done);
	flush(process.stderr, done);
	// Why a fallback: a reader that stops reading the pipe would hold the callbacks forever.
	setTimeout(() => {
		// oxlint-disable-next-line unicorn/no-process-exit -- this function exists to end the process.
		process.exit();
	}, FLUSH_TIMEOUT_MS).unref();
}

/** Calls `done` after `stream` writes what it holds. */
function flush(stream: NodeJS.WriteStream, done: () => void): void {
	if ("Bun" in globalThis) {
		// Why `end` on Bun: on Bun 1.3, the callback of a write runs before a full pipe takes the
		// earlier writes. The callback of `end` waits for them. A write after `end` still works on Bun.
		stream.end(done);
		return;
	}
	// Why a write: its callback runs after each earlier write. A pipe on macOS writes async.
	// Why not `end` on Node: a write after `end` throws there.
	stream.write("", done);
}
