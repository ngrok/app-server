import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultApp, loadEntry } from "./load-entry.js";
import { errorAttributes } from "./log.js";

/**
 * Loads a production server build and listens. On `SIGTERM` or `SIGINT`, it
 * shuts down: see `RunningServer.shutdown`.
 */
export async function start({ buildPath }: { buildPath: string }): Promise<void> {
	const entry: unknown = await import(pathToFileURL(resolve(buildPath)).href);
	const { framework, internals } = await loadEntry(entry, {
		mode: "production",
		fallbackApp: defaultApp,
	});
	await internals.prepare({
		mode: "production",
		clientDirectory: framework.clientDirectory,
		prerenderedPaths: framework.prerenderedPaths,
		logger: internals.logger,
	});
	const server = await internals.listen(framework);
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.once(signal, () => {
			server.shutdown().catch((error: unknown) => {
				internals.logger.log("error", "shutdown failed", errorAttributes(error));
				process.exitCode = 1;
			});
		});
	}
}
