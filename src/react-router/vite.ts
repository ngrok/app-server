import type { FrameworkBuild } from "../vite/index.js";

/**
 * The build side of the React Router adapter.
 *
 * @example
 * appServer({ framework: reactRouterAdapter(), host: node(), app: "./server.ts" });
 */
export function reactRouterAdapter(): FrameworkBuild {
	return {
		name: "react-router",
		serverModule: "virtual:react-router/server-build",
		runtimeModule: "@ngrok/app-server/react-router",
		// Why this flag: React Router sets it for the preview server of its prerender pass only.
		isPrerenderPass: () => process.env.IS_RR_BUILD_REQUEST === "yes",
		validate: (config) => {
			if (config.base !== "/") {
				throw new Error(
					`@ngrok/app-server serves a build at "/" only, and this config has the base "${config.base}".`,
				);
			}
		},
	};
}
