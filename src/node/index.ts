import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "hono";
import type { AppServerEnv, HostRuntime } from "../core/types.js";
import { exitAfterFlush } from "./exit.js";
import { nodeFiles } from "./files.js";
import { gzipStream } from "./gzip.js";
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
 * `SIGINT`, it shuts down, then exits the process.
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
	lifecycle: {
		onStop: (stop) => {
			for (const signal of ["SIGTERM", "SIGINT"] as const) {
				process.once(signal, () => {
					stop()
						.catch(() => {
							process.exitCode = 1;
						})
						.finally(exitAfterFlush);
				});
			}
		},
	},
};
