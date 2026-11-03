import type { HostBuild } from "../vite/index.js";

/**
 * The build side of the node host, the default host of `appServer`. The
 * server build gets `server/app-server.js`, which `app-server serve` runs.
 *
 * @example
 * appServer({ host: node() });
 */
export function node(): HostBuild {
	return {
		name: "node",
		runtimeModule: "@ngrok/app-server/node",
		entryFileName: "app-server.js",
	};
}
