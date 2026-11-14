import { AsyncLocalStorage } from "node:async_hooks";
import { asError } from "../core/log.js";
import { logger } from "../core/request-context.js";
import type { HostRuntime, RequestScope } from "../core/types.js";
import { exitAfterFlush } from "./exit.js";
import { nodeFiles } from "./files.js";
import { brotliStream, gzipStream } from "./compress.js";
import { logWriter } from "./stdout.js";
import { tcp } from "./tcp.js";

export {
	//,
	tcp,
} from "./tcp.js";

export type {
	//,
	NodeBindings,
} from "./dev-server.js";
export type {
	//,
	TcpOptions,
} from "./tcp.js";

const storage = new AsyncLocalStorage<RequestScope>();

/** The crash handler of each stop that the host registered, for a rejection that no app listener handles on Bun. */
const rejectionCrashes = new Set<(error: unknown, origin: string) => void>();

/**
 * Crashes each registered server for a rejection that the app does not handle.
 * Why one listener before the others: an app's `process.once` listener
 * removes itself before it runs, and a listener for each server would count
 * as an app listener.
 */
function onRejection(reason: unknown): void {
	if (process.listenerCount("unhandledRejection") > 1) {
		return;
	}
	process.off("unhandledRejection", onRejection);
	const crashes = [...rejectionCrashes];
	rejectionCrashes.clear();
	for (const crash of crashes) {
		crash(reason, "unhandledRejection");
	}
}

/**
 * The node host: one long-lived process on Node, Bun, or Deno, such as a
 * Docker image. It listens with `tcp()`, reads the client build from the file
 * system, and keeps `requestContext()` in `AsyncLocalStorage`. On `SIGTERM` or
 * `SIGINT`, it shuts down, then exits the process. After an uncaught error, it
 * logs `uncaught exception`, shuts down, then exits with code 1.
 *
 * @example
 * export const appServer = createEntry({ app, host, framework: (mode) => runtime(build, { mode }) });
 */
export const host: HostRuntime = {
	files: nodeFiles,
	listeners: [tcp()],
	storage: {
		run: (value, work) => storage.run(value, work),
		get: () => storage.getStore(),
	},
	gzip: gzipStream,
	brotli: brotliStream,
	logWriter,
	lifecycle: {
		onStop: (stop) => {
			const exit = () => {
				stop()
					.catch(() => {
						process.exitCode = 1;
					})
					.finally(exitAfterFlush);
			};
			for (const signal of ["SIGTERM", "SIGINT"] as const) {
				process.once(signal, exit);
			}
			// Why drain: an error in one request must not cut each other open request.
			const crash = (error: unknown, origin: string) => {
				logger().error("uncaught exception", {
					error: asError(error),
					"app_server.origin": origin,
				});
				process.exitCode = 1;
				exit();
			};
			// Why once: an error loop gets the runtime's own stop, not a log line for each error.
			process.once("uncaughtException", crash);
			// Why: Bun does not send a rejection with no handler to `uncaughtException`, as Node.js and Deno do.
			if ("Bun" in globalThis) {
				if (rejectionCrashes.size === 0) {
					process.prependListener("unhandledRejection", onRejection);
				}
				rejectionCrashes.add(crash);
			}
		},
	},
};
