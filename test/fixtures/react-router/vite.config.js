// The React Router app for `test/runtimes.ts`. It builds with the built package. Why relative imports:
// Vite bundles this config into `node_modules`, where the package cannot import itself by name.
import { reactRouter } from "@react-router/dev/vite";
import { node } from "../../../dist/node-vite.js";
import { reactRouterAdapter } from "../../../dist/react-router-vite.js";
import { appServer } from "../../../dist/vite.js";

export default {
	logLevel: "warn",
	plugins: [
		reactRouter(),
		appServer({ framework: reactRouterAdapter(), host: node(), app: "./server.js" }),
	],
};
