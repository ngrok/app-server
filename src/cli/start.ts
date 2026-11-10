import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import type { Plugin } from "vite";
import { errorAttributes, jsonSink } from "../core/log.js";
import { devServerStage } from "../node/dev-server.js";
import { exitAfterFlush } from "../node/exit.js";
import { listenerUrl } from "../node/runtimes/listen-options.js";
import { requestListener } from "../node/response-writer.js";
import { parsePort } from "../node/tcp.js";
import { SERVER_ENTRY_ID } from "../vite/index.js";
import { loadEntry } from "./load-entry.js";
import { servedApps } from "./served-apps.js";
import { listenFromPort } from "./start-port.js";

/**
 * Runs the app in development: the same pipeline as production, with Vite in
 * middleware mode inside it. Each request loads the server entry through
 * Vite's SSR runner, so an edit to a route or to the app's `server.ts` applies
 * at once. HMR shares the port. Vite's plugins get the CLI's HTTP server as
 * `server.httpServer`.
 *
 * The port is `--port`, else `PORT`, else Vite's `server.port`. When that port is in use, the
 * server tries each next port, unless Vite's `server.strictPort` is true. The
 * host is `HOST`, else Vite's `server.host`.
 */
export async function start(): Promise<void> {
	const vite = await import("vite");
	const httpServer = createHttpServer();
	const viteServer = await vite.createServer({
		// Why `true`, not `{ server }`: Vite then adds a proxy `upgrade` listener to the server, and a
		// restart does not remove it.
		server: { middlewareMode: true, ws: { server: httpServer } },
		appType: "custom",
		plugins: [shareHttpServer(httpServer)],
	});
	// Why read it for each request: a Vite restart, such as after a config edit, replaces the environments.
	const ssrRunner = () => {
		const { ssr } = viteServer.environments;
		if (ssr == null || !vite.isRunnableDevEnvironment(ssr)) {
			throw new Error("Vite's SSR environment cannot run modules.");
		}
		return ssr.runner;
	};
	ssrRunner();
	if (!viteServer.config.plugins.some((plugin) => plugin.name === "@ngrok/app-server")) {
		await viteServer.close();
		throw new Error(
			"`app-server start` needs the `appServer` plugin from @ngrok/app-server/vite in the Vite config.",
		);
	}
	const devServer = devServerStage(viteServer.middlewares, {
		publicFiles: () => ({ directory: viteServer.config.publicDir, base: viteServer.config.base }),
	});
	const sink = jsonSink();
	const apps = servedApps();

	const listener = requestListener(async (request, bindings) => {
		try {
			return await apps.serve(
				await loadEntry(await ssrRunner().import(SERVER_ENTRY_ID)),
				async (entry) => entry.fetchDev(request, bindings, devServer),
			);
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
	const hostname = process.env.HOST || viteHostname(viteServer.config.server.host);
	const boundPort = await listenFromPort(httpServer, {
		port,
		hostname,
		strictPort: viteServer.config.server.strictPort,
		onPortInUse: (inUse) => {
			sink.log("info", "port in use, trying the next port", { "server.port": inUse });
		},
		onWildcardInUse: (inUse) => {
			sink.log("warn", "port in use on a wildcard address", {
				"server.port": inUse,
				"server.address": hostname,
			});
		},
	});
	sink.log("info", "listening", { "app_server.urls": [listenerUrl(hostname, boundPort)] });

	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.once(signal, () => {
			const pluginsStopped = apps.stopAll();
			httpServer.closeAllConnections();
			const httpClosed = new Promise<void>((resolve) => {
				httpServer.close(() => {
					resolve();
				});
			});
			const viteClosed = viteServer.close().catch((error: unknown) => {
				sink.log("error", "Vite close failed", errorAttributes(error));
				process.exitCode = 1;
			});
			void Promise.all([pluginsStopped, httpClosed, viteClosed]).finally(exitAfterFlush);
		});
	}
}

/**
 * A Vite plugin that sets `server.httpServer` to the CLI's HTTP server before
 * the `configureServer` hooks of the app's plugins run. Why: in middleware
 * mode, Vite sets it to `null`. Then a plugin that waits for `listening` or
 * `close` on it does nothing, with no error.
 *
 * @example
 * vite.createServer({ plugins: [shareHttpServer(httpServer)] });
 */
function shareHttpServer(httpServer: Server): Plugin {
	return {
		name: "@ngrok/app-server:http-server",
		enforce: "pre",
		configureServer: {
			order: "pre",
			handler: (server) => {
				server.httpServer = httpServer;
			},
		},
	};
}

/** The hostname for Vite's `server.host`: `true` is every interface, and no value is `localhost`. */
function viteHostname(host: string | boolean | undefined): string | undefined {
	if (host === true) {
		return undefined;
	}
	return typeof host === "string" && host !== "" ? host : "localhost";
}
