import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "hono";
import { asError } from "../core/log.js";
import { logger } from "../core/request-context.js";
import type { AppServerEnv, HostRuntime } from "../core/types.js";
import { exitAfterFlush } from "./exit.js";
import { nodeFiles } from "./files.js";
import { brotliStream, gzipStream } from "./compress.js";
import { tcp } from "./tcp.js";

export {
	//,
	devServerStage,
} from "./dev-server.js";
export {
	//,
	nodeFiles,
} from "./files.js";
export {
	//,
	parsePort,
	tcp,
} from "./tcp.js";

export type {
	//,
	DevServerStageOptions,
	NodeBindings,
	NodeMiddleware,
} from "./dev-server.js";
export type {
	//,
	TcpOptions,
} from "./tcp.js";

const storage = new AsyncLocalStorage<Context<AppServerEnv>>();

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
	name: "node",
	files: nodeFiles,
	listeners: () => [tcp()],
	storage: {
		run: (value, work) => storage.run(value, work),
		get: () => storage.getStore(),
	},
	gzip: gzipStream,
	brotli: brotliStream,
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
			if ("Bun" in globalThis) {
				// Why: Bun does not send a rejection with no handler to `uncaughtException`, as Node.js and Deno do.
				process.once("unhandledRejection", (reason) => {
					crash(reason, "unhandledRejection");
				});
			}
		},
	},
};
