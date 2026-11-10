// The Vite config for the `app-server start` check in `test/runtimes.ts`. Its plugin stands in for
// `serverEntry`: it points the server entry at `entry.js`, which uses the built package.
import { join } from "node:path";

const entry = join(import.meta.dirname, "entry.js");

export default {
	cacheDir: join(import.meta.dirname, "../../../node_modules/.vite-dev-fixture"),
	logLevel: "silent",
	// Why: a WebSocket proxy route, so the check sees whether Vite adds an `upgrade` listener.
	server: { proxy: { "/proxied": { target: "ws://127.0.0.1:9", ws: true } } },
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
					});
				},
			},
		},
	],
};
