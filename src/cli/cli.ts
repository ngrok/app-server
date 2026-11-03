#!/usr/bin/env node
// The `app-server` command: `app-server start` or `app-server serve [build/server/app-server.js]`,
// each with an optional `--port`.
import process from "node:process";
import { parseArgs } from "node:util";
import { parsePort } from "../node/tcp.js";

const USAGE =
	"Usage: app-server start [--port <port>] | app-server serve [--port <port>] [build/server/app-server.js]";

/** Writes `message` and the usage to stderr, and sets a failed exit code. */
function fail(message: string): void {
	process.stderr.write(`${message}\n${USAGE}\n`);
	process.exitCode = 1;
}

/** The parsed arguments. A bad argument throws. */
function parse() {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		strict: true,
		options: { port: { type: "string", short: "p" }, help: { type: "boolean", short: "h" } },
	});
	// Why set `PORT`: the copy of this package in the build reads it, so the flag needs no change to
	// the entry protocol.
	if (values.port != null) {
		process.env.PORT = String(parsePort(values.port));
	}
	return { command: positionals[0], buildPath: positionals[1], help: values.help === true };
}

let args: ReturnType<typeof parse> | undefined;
try {
	args = parse();
} catch (error) {
	// Why no stack: a bad argument is a usage error, not a crash.
	fail(String(error instanceof Error ? error.message : error).replace(/^PORT\b/u, "--port"));
}

// Why dynamic imports: React reads `NODE_ENV` when it loads, and a static import runs first.
if (args?.help === true) {
	process.stdout.write(`${USAGE}\n`);
} else if (args?.command === "start") {
	process.env.NODE_ENV ??= "development";
	const { start } = await import("./start.js");
	await start();
} else if (args?.command === "serve") {
	process.env.NODE_ENV ??= "production";
	if (typeof process.setSourceMapsEnabled === "function") {
		process.setSourceMapsEnabled(true);
	}
	const { serve } = await import("./serve.js");
	await serve({ buildPath: args.buildPath });
} else if (args != null) {
	fail(args.command == null ? "Give a command." : `Unknown command: ${args.command}.`);
}
