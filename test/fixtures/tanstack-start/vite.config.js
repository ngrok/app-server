// The TanStack Start app for `test/runtimes.ts`. It builds with the built package. Why relative imports:
// Vite bundles this config into `node_modules`, where the package cannot import itself by name.
// Why no options: `appServer` finds the framework, uses the node host, and uses `server.js`.
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { appServer } from "../../../dist/vite.js";

export default {
	// Why `info`: `app-server start` prints its URL at this level, and the check reads it.
	logLevel: "info",
	plugins: [
		tanstackStart({
			prerender: { enabled: true, crawlLinks: false, autoStaticPathsDiscovery: false },
			pages: [{ path: "/" }, { path: "/hello.txt" }],
		}),
		viteReact(),
		appServer(),
	],
};
