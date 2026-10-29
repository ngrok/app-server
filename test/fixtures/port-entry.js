// A server build entry for `test/runtimes.ts` that reads its port from the CLI: `--port`, else `PORT`.
import { fileURLToPath } from "node:url";
import { createEntry, createServer, tcp } from "../../dist/index.js";

export const appServer = createEntry({
	app: createServer({ listeners: [tcp({ host: "127.0.0.1" })] }),
	framework: () => ({
		clientDirectory: fileURLToPath(new URL("client", import.meta.url)),
		prerenderedPaths: [],
		fetch: async () => new Response("ok"),
	}),
});
