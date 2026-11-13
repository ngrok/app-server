// The Vite config for the `app-server start` check in `test/runtimes.ts`. Its plugin stands in for
// `serverEntry`: it points the server entry at `entry.js`, which uses the built package.
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createLogger } from "vite";

const entry = join(import.meta.dirname, "entry.js");
const logger = createLogger("info");

/**
 * Vite's logger method for `level`, which also writes each message as a JSON line for the check.
 * Why Vite's line first: the check reads the server's URL from the first line that has it.
 */
function recorded(level) {
	return (message, options) => {
		logger[level](message, options);
		const text = stripVTControlCharacters(message);
		process.stdout.write(`${JSON.stringify({ level, message: "vite logger", text })}\n`);
	};
}

export default {
	cacheDir: join(import.meta.dirname, "../../../node_modules/.vite-dev-fixture"),
	// Why `info`: `app-server start` prints its URL at this level, and the check reads it.
	logLevel: "info",
	// Why: the check sees which lines `start` gives to Vite's logger.
	customLogger: { ...logger, info: recorded("info"), warn: recorded("warn") },
	server: {
		// Why: a WebSocket proxy route, so the check sees whether Vite adds an `upgrade` listener.
		proxy: { "/proxied": { target: "ws://127.0.0.1:9", ws: true } },
		// Why: `start` serves HTTP only, and the check sees that it says so and keeps Vite's host check.
		https: {},
		// Why only with `BROWSER`: the check gives a script. A run by hand opens no browser.
		open: process.env.BROWSER != null,
	},
	plugins: [
		{
			name: "@ngrok/app-server",
			resolveId: (id) => (id === "virtual:@ngrok/app-server/entry" ? entry : undefined),
		},
		{
			// Why: a plugin that waits for the HTTP server's events, as some apps' plugins do. Why both
			// `pre` settings: the hook then runs as early as an app's hook can.
			name: "http-server-events",
			enforce: "pre",
			configureServer: {
				order: "pre",
				handler: (server) => {
					for (const event of ["listening", "close"]) {
						server.httpServer?.once(event, () => {
							process.stdout.write(`${JSON.stringify({ message: `vite plugin saw ${event}` })}\n`);
						});
					}
					server.httpServer?.once("listening", () => {
						const upgrades = server.httpServer?.listenerCount("upgrade");
						process.stdout.write(`${JSON.stringify({ message: "upgrade listeners", upgrades })}\n`);
						const urls = server.resolvedUrls?.local;
						process.stdout.write(`${JSON.stringify({ message: "resolved URLs", urls })}\n`);
					});
				},
			},
		},
	],
};
