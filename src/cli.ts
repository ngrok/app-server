#!/usr/bin/env node
// The `app-server` command: `app-server start` or `app-server serve [build/server/index.js]`.
import process from "node:process";
import { parseArgs } from "node:util";

const USAGE = "Usage: app-server start | app-server serve [build/server/index.js]";

const { positionals } = parseArgs({ allowPositionals: true, strict: true, options: {} });
const [command, buildPath = "build/server/index.js"] = positionals;

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
