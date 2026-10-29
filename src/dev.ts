import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createServer, type ServerInternals } from "./create-server.js";
import { loadEntry } from "./load-entry.js";
import { errorAttributes, jsonSink } from "./log.js";
import { listenerUrl } from "./runtimes/listen-options.js";
import { abortShutdownSignal } from "./shutdown.js";
import { parsePort } from "./tcp.js";
import { SERVER_ENTRY_ID } from "./vite.js";

/**
 * Runs the app in development: the same pipeline as production, with Vite in
 * middleware mode inside it. Each request loads the server entry through
 * Vite's SSR runner, so an edit to a route or to the app's `server.ts` applies
 * at once. HMR shares the port.
 *
 * The port is `PORT`, else Vite's `server.port`. The host is `HOST`, else
 * Vite's `server.host`.
 */
export async function dev(): Promise<void> {
	const vite = await import("vite");
	const httpServer = createHttpServer();
	const viteServer = await vite.createServer({
		server: { middlewareMode: true, ws: { server: httpServer } },
		appType: "custom",
	});
	// Why read it for each request: a Vite restart, such as after a config edit, replaces the environments.
	const ssrRunner = () => {
		const ssr = viteServer.environments.ssr;
		if (ssr == null || !vite.isRunnableDevEnvironment(ssr)) {
			throw new Error("Vite's SSR environment cannot run modules.");
		}
		return ssr.runner;
	};
	ssrRunner();
	const entryId = viteServer.config.plugins.some((plugin) => plugin.name === "@ngrok/app-server")
		? SERVER_ENTRY_ID
		: "virtual:react-router/server-build";
	const sink = jsonSink();
	let fallback: unknown;
	// Why keep it: a stop signal runs the `onShutdown` hooks of the app that served last.
	let lastInternals: ServerInternals | undefined;

	const listener = getRequestListener(async (request, { incoming, outgoing }) => {
		try {
			const { framework, internals, fetch } = await loadEntry(await ssrRunner().import(entryId), {
				mode: "development",
				fallbackApp: () => {
					fallback ??= createServer({ logger: sink });
					return fallback;
				},
			});
			lastInternals = internals;
			await internals.prepare({
				mode: "development",
				viteMiddleware: viteServer.middlewares,
				clientDirectory: framework.clientDirectory,
				prerenderedPaths: framework.prerenderedPaths,
				logger: internals.logger,
			});
			return await fetch(request, {
				remoteAddress: incoming.socket.remoteAddress,
				framework,
				// Why the check: the listener is plain `node:http`, so these are always HTTP/1 objects.
				...(incoming instanceof IncomingMessage && outgoing instanceof ServerResponse
					? { incoming, outgoing }
					: {}),
			});
		} catch (error) {
			if (error instanceof Error) {
				viteServer.ssrFixStacktrace(error);
			}
			sink.log("error", "dev request failed", errorAttributes(error));
			return new Response(error instanceof Error ? (error.stack ?? error.message) : String(error), {
				status: 500,
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		}
	});
	httpServer.on("request", (request, response) => {
		void listener(request, response);
	});

	const port =
		process.env.PORT == null ? viteServer.config.server.port : parsePort(process.env.PORT);
	const configuredHost = viteServer.config.server.host;
	const hostname =
		process.env.HOST || (configuredHost === true ? undefined : configuredHost || "localhost");
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(port, hostname, () => {
			httpServer.off("error", reject);
			resolve();
		});
	});
	sink.log("info", "listening", { "app_server.urls": [listenerUrl(hostname, port)] });

	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.once(signal, () => {
			abortShutdownSignal();
			void lastInternals?.stopPlugins();
			httpServer.closeAllConnections();
			httpServer.close();
			viteServer.close().catch((error: unknown) => {
				sink.log("error", "Vite close failed", errorAttributes(error));
				process.exitCode = 1;
			});
		});
	}
}
