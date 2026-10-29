#!/usr/bin/env node
// The `app-server` command: `app-server start` or `app-server serve [build/server/app-server.js]`,
// each with an optional `--port`.
import process from "node:process";
import { parseArgs } from "node:util";
import { parsePort } from "../node/tcp.js";

const USAGE =
	"Usage: app-server start [--port <port>] | app-server serve [--port <port>] [build/server/app-server.js]";

const { positionals, values } = parseArgs({
	allowPositionals: true,
	strict: true,
	options: { port: { type: "string" } },
});
const [command, buildPath] = positionals;

// Why set `PORT`: the copy of this package in the build reads it, so the flag needs no change to
// the entry protocol.
if (values.port != null) {
	process.env.PORT = String(parsePort(values.port));
}

// Why dynamic imports: React reads `NODE_ENV` when it loads, and a static import runs first.
switch (command) {
	case "start": {
		process.env.NODE_ENV ??= "development";
		const { start } = await import("./start.js");
		await start();
		break;
	}
	case "serve": {
		process.env.NODE_ENV ??= "production";
		if (typeof process.setSourceMapsEnabled === "function") {
			process.setSourceMapsEnabled(true);
		}
		const { serve } = await import("./serve.js");
		await serve({ buildPath });
		break;
	}
	default: {
		process.stderr.write(`${USAGE}\n`);
		process.exitCode = 1;
	}
}
