// A server build entry for `test/runtimes.ts` that reads its port from the CLI: `--port`, else `PORT`.
import { fileURLToPath } from "node:url";
import { createEntry, createServer } from "../../dist/index.js";
import { host, tcp } from "../../dist/node.js";

export const appServer = createEntry({
	app: createServer({ listeners: [tcp({ host: "127.0.0.1" })] }),
	host,
	framework: () => ({
		name: "stub",
		clientDirectory: fileURLToPath(new URL("client", import.meta.url)),
		fetch: async () => new Response("ok"),
	}),
});
