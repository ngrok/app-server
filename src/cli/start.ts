import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import { styleText } from "node:util";
import type { Plugin, ResolvedServerUrls } from "vite";
import { asError, hookSink, textSink } from "../core/log.js";
import { devServerStage } from "../node/dev-server.js";
import { exitAfterFlush } from "../node/exit.js";
import { requestListener } from "../node/response-writer.js";
import { parsePort } from "../node/tcp.js";
import { SERVER_ENTRY_ID } from "../vite/entry-source.js";
import { devUrlLines, devUrls } from "./dev-urls.js";
import { loadEntry } from "./load-entry.js";
import { servedApps } from "./served-apps.js";
import { boundPort, listenFromPort } from "./start-port.js";

/**
 * Runs the app in development: the same pipeline as production, with Vite in
 * middleware mode inside it. Each request loads the server entry through
 * Vite's SSR runner, so an edit to a route or to the app's `server.ts` applies
 * at once. HMR shares the port. Vite's plugins get the CLI's HTTP server as
 * `server.httpServer`, and its URLs as `server.resolvedUrls`.
 *
 * The port is `--port`, else `PORT`, else Vite's `server.port`. When that port is in use, the
 * server tries each next port, unless Vite's `server.strictPort` is true. The
 * host is `HOST`, else Vite's `server.host`. Vite's `server.open` opens the browser. The server
 * speaks HTTP only: see `shareHttpServer` for `server.https`.
 */
export async function start(): Promise<void> {
	const vite = await import("vite");
	const httpServer = createHttpServer();
	/** The host and the port that the HTTP server listens on. No value before it listens. */
	let listensOn: { hostname: string | undefined; port: number } | undefined;
	const resolvedUrls = (base: string) =>
		listensOn == null ? null : devUrls({ ...listensOn, base });
	const viteServer = await vite.createServer({
		// Why `true`, not `{ server }`: Vite then adds a proxy `upgrade` listener to the server, and a
		// restart does not remove it.
		server: { middlewareMode: true, ws: { server: httpServer } },
		appType: "custom",
		plugins: [shareHttpServer({ httpServer, resolvedUrls })],
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
	const sink = hookSink(textSink());
	const apps = servedApps();

	const listener = requestListener(async (request, bindings) => {
		try {
			return await apps.serve(
				await loadEntry(await ssrRunner().import(SERVER_ENTRY_ID)),
				async (entry) => entry.fetchDev(request, { bindings, devServer }),
			);
		} catch (error) {
			if (error instanceof Error) {
				viteServer.ssrFixStacktrace(error);
			}
			sink.log({
				level: "error",
				message: "dev request failed",
				attributes: { error: asError(error) },
			});
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
	// Why Vite's logger and Vite's words: the lines then follow the app's `logLevel` and
	// `customLogger`, as in `vite dev`.
	const { logger } = viteServer.config;
	// Why prepend: the `listening` listener of a plugin then reads `server.resolvedUrls`, as in `vite dev`.
	httpServer.prependOnceListener("listening", () => {
		listensOn = { hostname, port: boundPort(httpServer, port) };
		viteServer.resolvedUrls = resolvedUrls(viteServer.config.base);
	});
	await listenFromPort(httpServer, {
		port,
		hostname,
		strictPort: viteServer.config.server.strictPort,
		onPortInUse: (inUse) => {
			logger.info(`Port ${inUse} is in use, trying another one...`);
		},
		onWildcardInUse: (inUse) => {
			logger.warn(
				styleText(
					"yellow",
					`Port ${inUse} is in use on a wildcard address, but ${hostname ?? "localhost"}:${inUse} is available. There may be another server running on a wildcard IP on port ${inUse}.`,
				),
			);
		},
	});
	logger.info("");
	for (const line of devUrlLines(viteServer.resolvedUrls ?? { local: [], network: [] })) {
		logger.info(line);
	}
	const { open } = viteServer.config.server;
	if (open === true || (typeof open === "string" && open !== "")) {
		viteServer.openBrowser();
	}

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
				sink.log({
					level: "error",
					message: "Vite close failed",
					attributes: { error: asError(error) },
				});
				process.exitCode = 1;
			});
			void Promise.all([pluginsStopped, httpClosed, viteClosed]).finally(exitAfterFlush);
		});
	}
}

/**
 * A Vite plugin that gives the CLI's HTTP server to the app's plugins, because Vite has no HTTP
 * server of its own in middleware mode:
 *
 * - It sets `server.httpServer` and `server.resolvedUrls` before the `configureServer` hooks of
 *   the app's plugins run. Vite sets both to `null`. Then a plugin that waits for `listening` or
 *   `close`, or that reads the URLs, does nothing, with no error.
 * - It removes a `server.https` that has HTTPS on, with a warning. The CLI makes the HTTP server
 *   before Vite reads the config, so the server speaks HTTP only.
 *
 * `resolvedUrls` gives the URLs for a base path, or `null` before the HTTP server listens.
 *
 * @example
 * vite.createServer({ plugins: [shareHttpServer({ httpServer, resolvedUrls: () => null })] });
 */
function shareHttpServer({
	httpServer,
	resolvedUrls,
}: {
	httpServer: Server;
	resolvedUrls: (base: string) => ResolvedServerUrls | null;
}): Plugin {
	const plugin: Plugin = {
		name: "@ngrok/app-server:http-server",
		configResolved: {
			// Why last: a plugin such as `@vitejs/plugin-basic-ssl` sets `server.https` in this hook.
			order: "post",
			handler: (config) => {
				// Why first: Vite puts an inline plugin after the config file's plugins, so an app plugin
				// with `enforce: "pre"` and `order: "pre"` runs its `configureServer` before this one.
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Vite sorts each hook from this array later.
				const plugins = config.plugins as Plugin[];
				plugins.splice(plugins.indexOf(plugin), 1);
				plugins.unshift(plugin);
				// Why remove it: with `server.https` set, Vite turns off its check of the `Host` header. A
				// plain HTTP server needs that check against a DNS rebinding attack.
				// Why by truth: Vite reads the option so, and `false` in a config has HTTPS off.
				if (config.server.https) {
					delete config.server.https;
					config.logger.warn(
						styleText(
							"yellow",
							"`app-server start` serves HTTP only, so it ignores `server.https`. For HTTPS in development, put a proxy or a tunnel that ends TLS in front of it.",
						),
					);
				}
			},
		},
		configureServer: {
			order: "pre",
			handler: (server) => {
				server.httpServer = httpServer;
				// Why here too: a Vite restart makes a new server with no URLs, and the HTTP server does
				// not emit `listening` again.
				server.resolvedUrls = resolvedUrls(server.config.base);
			},
		},
	};
	return plugin;
}

/** The hostname for Vite's `server.host`: `true` is every interface, and no value is `localhost`. */
function viteHostname(host: string | boolean | undefined): string | undefined {
	if (host === true) {
		return undefined;
	}
	return typeof host === "string" && host !== "" ? host : "localhost";
}
