// A server build entry for the `app-server start` check in `test/runtimes.ts`.
import { fileURLToPath } from "node:url";
import { createEntry, createServer } from "../../../dist/index.js";

export const appServer = createEntry({
	app: createServer(),
	framework: () => ({
		clientDirectory: fileURLToPath(new URL("../client", import.meta.url)),
		prerenderedPaths: [],
		fetch: async () => {
			// Why: React Router's `entry.server` leaves a render abort timer like this one.
			setTimeout(() => {}, 60_000);
			return new Response("rendered", { headers: { "Content-Type": "text/html" } });
		},
	}),
});
