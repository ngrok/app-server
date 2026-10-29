import type { FrameworkBuild } from "../vite/index.js";

/**
 * The build side of the TanStack Start adapter. In `app-server start`, Vite
 * runs in middleware mode, so Start skips its own SSR middleware, and the
 * pipeline renders each page.
 *
 * @example
 * appServer({ framework: tanstackStartAdapter(), host: node(), app: "./server.ts" });
 */
export function tanstackStartAdapter(): FrameworkBuild {
	return {
		name: "tanstack-start",
		serverModule: "virtual:tanstack-start-server-entry",
		runtimeModule: "@ngrok/app-server/tanstack-start",
		// Why in the entry: Start defines `TSS_SERVER_FN_BASE` at build time, so only bundled code sees it.
		runtimeOptions: "{ serverFnBase: process.env.TSS_SERVER_FN_BASE }",
		// Why this flag: Start sets it in the build process before it starts the preview server
		// of its prerender pass.
		isPrerenderPass: () => process.env.TSS_PRERENDERING === "true",
		validate: (config) => {
			if (config.base !== "/") {
				throw new Error(
					`@ngrok/app-server serves a build at "/" only, and this config has the base "${config.base}".`,
				);
			}
		},
	};
}
