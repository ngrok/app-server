#!/usr/bin/env node
// The `app-server` command: `app-server dev` or `app-server start [build/server/index.js]`.
import process from "node:process";
import { parseArgs } from "node:util";

const USAGE = "Usage: app-server dev | app-server start [build/server/index.js]";

const { positionals } = parseArgs({ allowPositionals: true, strict: true, options: {} });
const [command, buildPath = "build/server/index.js"] = positionals;

// Why dynamic imports: React reads `NODE_ENV` when it loads, and a static import runs first.
switch (command) {
	case "start": {
		process.env.NODE_ENV ??= "production";
		if (typeof process.setSourceMapsEnabled === "function") {
			process.setSourceMapsEnabled(true);
		}
		const { start } = await import("./start.js");
		await start({ buildPath });
		break;
	}
	case "dev": {
		process.env.NODE_ENV ??= "development";
		const { dev } = await import("./dev.js");
		await dev();
		break;
	}
	default: {
		process.stderr.write(`${USAGE}\n`);
		process.exitCode = 1;
	}
}
