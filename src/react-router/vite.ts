import type { FrameworkBuild } from "../vite/index.js";
import { CONTENT_TYPES } from "./content-types.js";

/**
 * The build side of the React Router adapter. `appServer` uses it when the
 * Vite config has the React Router plugin, so pass it only to override that.
 *
 * @example
 * appServer({ framework: reactRouterAdapter() });
 */
export function reactRouterAdapter(): FrameworkBuild {
	return {
		serverModule: "virtual:react-router/server-build",
		runtimeModule: "@ngrok/app-server/react-router",
		contentTypes: CONTENT_TYPES,
		// Why this flag: React Router sets it for the preview server of its prerender pass only.
		isPrerenderPass: () => process.env.IS_RR_BUILD_REQUEST === "yes",
	};
}
