// The Vite config for the `app-server start` check in `test/runtimes.ts`. Its plugin stands in for
// `serverEntry`: it points the server entry at `entry.js`, which uses the built package.
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("entry.js", import.meta.url));

export default {
	cacheDir: fileURLToPath(new URL("../../../node_modules/.vite-dev-fixture", import.meta.url)),
	logLevel: "silent",
	plugins: [
		{
			name: "@ngrok/app-server",
			resolveId: (id) => (id === "virtual:@ngrok/app-server/entry" ? entry : undefined),
		},
	],
};
