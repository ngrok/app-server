// The TanStack Start app for `test/runtimes.ts`. It builds with the built package. Why relative imports:
// Vite bundles this config into `node_modules`, where the package cannot import itself by name.
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { node } from "../../../dist/node-vite.js";
import { tanstackStartAdapter } from "../../../dist/tanstack-start-vite.js";
import { appServer } from "../../../dist/vite.js";

export default {
	logLevel: "warn",
	plugins: [
		tanstackStart({
			prerender: { enabled: true, crawlLinks: false, autoStaticPathsDiscovery: false },
			pages: [{ path: "/" }, { path: "/hello.txt" }],
		}),
		viteReact(),
		appServer({ framework: tanstackStartAdapter(), host: node(), app: "./server.js" }),
	],
};
