import type { HostBuild } from "../vite/index.js";

/**
 * The build side of the node host, the default host of `appServer`. The
 * server build gets `server/app-server.js`. Run it with `node`, `bun`, or
 * `deno run`, or load it with `app-server serve`.
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
