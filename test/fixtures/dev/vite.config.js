// The Vite config for the `app-server start` check in `test/runtimes.ts`. Its plugin stands in for
// `serverEntry`: it points the server entry at `entry.js`, which uses the built package.
import { join } from "node:path";

const entry = join(import.meta.dirname, "entry.js");

export default {
	cacheDir: join(import.meta.dirname, "../../../node_modules/.vite-dev-fixture"),
	logLevel: "silent",
	plugins: [
		{
			name: "@ngrok/app-server",
			resolveId: (id) => (id === "virtual:@ngrok/app-server/entry" ? entry : undefined),
		},
	],
};
