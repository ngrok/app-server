// A server build entry for the `app-server start` check in `test/runtimes.ts`.
import { join } from "node:path";
import { createEntry, createServer } from "../../../dist/index.js";
import { host } from "../../../dist/node.js";

export const appServer = createEntry({
	app: createServer(),
	host,
	framework: () => ({
		name: "stub",
		clientDirectory: join(import.meta.dirname, "../client"),
		fetch: async () => {
			// Why: React Router's `entry.server` leaves a render abort timer like this one.
			setTimeout(() => {}, 60_000);
			return new Response("rendered", { headers: { "Content-Type": "text/html" } });
		},
	}),
});
