// The React Router app for `test/runtimes.ts`. It builds with the built package. Why relative imports:
// Vite bundles this config into `node_modules`, where the package cannot import itself by name.
// Why no other options: `appServer` finds the framework, uses the node host, and uses `server.js`.
// Why `ssr.external`: the build copies the package, whole, into `build/server/node_modules`.
import { reactRouter } from "@react-router/dev/vite";
import { vercel } from "../../../dist/vercel-vite.js";
import { appServer } from "../../../dist/vite.js";

export default {
	// Why `info` for the vercel host: `test/runtimes.ts` reads the report of `vercel()`, which goes
	// through Vite's logger at that level.
	logLevel: process.env.APP_SERVER_HOST === "vercel" ? "info" : "warn",
	ssr: { external: ["@fixture/cjs-greeting"] },
	plugins: [
		reactRouter(),
		// Why an env switch: `test/runtimes.ts` builds this app once for each host.
		appServer(process.env.APP_SERVER_HOST === "vercel" ? { host: vercel({ cdnPages: true }) } : {}),
	],
};
