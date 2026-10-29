import type { HostBuild } from "../vite/index.js";

/**
 * The build side of the node host: the server build gets
 * `server/app-server.js`, which `app-server serve` runs.
 *
 * @example
 * appServer({ framework: reactRouterAdapter(), host: node(), app: "./server.ts" });
 */
export function node(): HostBuild {
	return {
		name: "node",
		runtimeModule: "@ngrok/app-server/node",
		entryFileName: "app-server.js",
	};
}
