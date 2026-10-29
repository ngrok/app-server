import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { loadEntry } from "./entry.js";
import { listenFromPort } from "./start-port.js";
import { errorAttributes, jsonSink } from "./log.js";
import { listenerUrl } from "./runtimes/listen-options.js";
import { cancelIfClosed } from "./runtimes/node.js";
import { servedApps } from "./served-apps.js";
import { parsePort } from "./tcp.js";
import { SERVER_ENTRY_ID } from "./vite.js";

/**
 * Runs the app in development: the same pipeline as production, with Vite in
 * middleware mode inside it. Each request loads the server entry through
 * Vite's SSR runner, so an edit to a route or to the app's `server.ts` applies
 * at once. HMR shares the port.
 *
 * The port is `--port`, else `PORT`, else Vite's `server.port`. When that port is in use, the
 * server tries each next port, unless Vite's `server.strictPort` is true. The
 * host is `HOST`, else Vite's `server.host`.
 */
export async function start(): Promise<void> {
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
	const apps = servedApps();

	const listener = getRequestListener(async (request, { incoming, outgoing }) => {
		try {
			const response = await apps.serve(
				await loadEntry(await ssrRunner().import(entryId)),
				(entry) =>
					entry.fetchDev(
						request,
						{
							remoteAddress: incoming.socket.remoteAddress,
							// Why the check: the listener is plain `node:http`, so these are always HTTP/1 objects.
							...(incoming instanceof IncomingMessage && outgoing instanceof ServerResponse
								? { incoming, outgoing }
								: {}),
						},
						viteServer.middlewares,
					),
			);
			return await cancelIfClosed(response, outgoing);
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
	const boundPort = await listenFromPort(httpServer, {
		port,
		hostname,
		strictPort: viteServer.config.server.strictPort,
		onPortInUse: (inUse) => {
			sink.log("info", "port in use, trying the next port", { "server.port": inUse });
		},
	});
	sink.log("info", "listening", { "app_server.urls": [listenerUrl(hostname, boundPort)] });

	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.once(signal, () => {
			apps.stopAll();
			httpServer.closeAllConnections();
			httpServer.close();
			viteServer.close().catch((error: unknown) => {
				sink.log("error", "Vite close failed", errorAttributes(error));
				process.exitCode = 1;
			});
		});
	}
}
