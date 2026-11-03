// The React Router app for `test/runtimes.ts`. It builds with the built package. Why relative imports:
// Vite bundles this config into `node_modules`, where the package cannot import itself by name.
// Why no options: `appServer` finds the framework, uses the node host, and uses `server.js`.
import { reactRouter } from "@react-router/dev/vite";
import { appServer } from "../../../dist/vite.js";

export default {
	logLevel: "warn",
	plugins: [reactRouter(), appServer()],
};
