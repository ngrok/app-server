// Runs the built CLI on Node, Bun, and Deno against one fixture and checks the same behavior on
// each: `node ./test/runtimes.ts [node|bun|deno ...]`. Build the package first. A runtime that is
// not installed fails the run, so CI cannot pass by skipping one.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { get, type IncomingMessage } from "node:http";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { constants, createGunzip } from "node:zlib";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const serveArgs = ["dist/cli.js", "serve", "test/fixtures/runtime-entry.js"];
const portArgs = ["dist/cli.js", "serve", "test/fixtures/port-entry.js"];
const devDirectory = fileURLToPath(new URL("fixtures/dev", import.meta.url));
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const commands: Record<string, (args: string[]) => [string, string[]]> = {
	node: (args) => ["node", args],
	bun: (args) => ["bun", args],
	deno: (args) => [
		"deno",
		["run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", ...args],
	],
};

type Line = { level: string; message: string; [attribute: string]: unknown };

/** Starts the CLI and resolves with its URL once it logs `listening`. */
function startServer(
	runtime: string,
	cliArgs = serveArgs,
	{
		cwd = packageDirectory,
		env = {},
		stderr = "inherit",
	}: { cwd?: string; env?: Record<string, string>; stderr?: "inherit" | "ignore" } = {},
) {
	const [command, args] = commands[runtime]?.(cliArgs) ?? ["", []];
	const child = spawn(command, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", stderr],
	});
	const lines: Line[] = [];
	let buffered = "";
	const url = new Promise<string>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			reject(new Error(`${runtime} exited with ${code} before it listened`));
		});
		child.stdout.on("data", (chunk: Buffer) => {
			buffered += chunk.toString();
			const parts = buffered.split("\n");
			buffered = parts.pop() ?? "";
			for (const part of parts) {
				// Why the check: in `start`, Vite can write lines that are not JSON.
				if (!part.startsWith("{")) {
					continue;
				}
				const line: Line = JSON.parse(part);
				lines.push(line);
				const urls = line["app_server.urls"];
				if (line.message === "listening" && Array.isArray(urls)) {
					resolve(String(urls[0]));
				}
			}
		});
	});
	return { child, lines, url };
}

function request(url: string, headers: Record<string, string> = {}): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		get(url, { headers }, resolve).once("error", reject);
	});
}

/** The exit code, or a rejection when the child runs past `ms`, so a hang fails the run. */
function exited(child: ChildProcess, ms: number): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`The server did not exit within ${ms} ms.`));
		}, ms);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (await check()) {
			return;
		}
		await new Promise((resolve) => {
			setTimeout(resolve, 100);
		});
	}
	throw new Error(`Timed out: ${what}`);
}

/** Listens on an open port on 127.0.0.1 and resolves with the server and its port. */
function holdPort(): Promise<{ server: Server; port: number }> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve({ server, port: typeof address === "object" && address != null ? address.port : 0 });
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => {
			resolve();
		});
	});
}

async function checkPort(runtime: string): Promise<void> {
	const held = await holdPort();
	const open = await holdPort();
	await close(open.server);
	try {
		const flagged = startServer(runtime, [...portArgs, "--port", String(open.port)], {
			env: { PORT: String(held.port) },
		});
		try {
			assert.equal(new URL(await flagged.url).port, String(open.port), "`--port` wins over `PORT`");
		} finally {
			flagged.child.kill("SIGKILL");
		}

		const busy = startServer(runtime, [...portArgs, "--port", String(held.port)], {
			stderr: "ignore",
		});
		busy.url.catch(() => {});
		assert.notEqual(
			await exited(busy.child, 5_000),
			0,
			"`serve` stops at once when its port is in use",
		);
	} finally {
		await close(held.server);
	}
}

async function check(runtime: string): Promise<void> {
	await checkPort(runtime);
	const { child, lines, url } = startServer(runtime);
	try {
		const base = await url;

		const page = await fetch(new URL("/cpu", base));
		assert.equal(page.status, 200, "a prerendered page answers at its own URL");
		assert.equal(await page.text(), "<h1>CPU</h1>\n");
		assert.equal(page.headers.get("x-captured"), "yes", "captured headers replay");
		assert.match(page.headers.get("etag") ?? "", /^W\//);

		const rendered = await fetch(new URL("/unknown", base), {
			headers: { "X-Request-Id": "abc-123" },
		});
		assert.equal(await rendered.text(), "rendered", "a path with no file goes to the framework");
		assert.equal(rendered.headers.get("x-request-id"), "abc-123");

		// The stream sends its shell and holds the rest until `/release`, so this read hangs if
		// compression holds the stream back.
		const streamed = await request(new URL("/stream", base).href, { "Accept-Encoding": "gzip" });
		assert.equal(streamed.headers["content-encoding"], "gzip");
		const gunzip = createGunzip({ flush: constants.Z_SYNC_FLUSH });
		streamed.pipe(gunzip);
		const shell = await new Promise<string>((resolve) => {
			gunzip.once("data", (chunk: Buffer) => resolve(chunk.toString()));
		});
		assert.equal(shell, "<html>shell", "the first gzip chunk arrives before the stream ends");
		await (await fetch(new URL("/release", base))).text();

		const held = await request(new URL("/hold", base).href);
		await new Promise<void>((resolve) => {
			held.once("data", () => resolve());
		});
		held.destroy();
		await waitFor(
			async () => (await (await fetch(new URL("/hold-status", base))).text()) === "true",
			"a client disconnect reaches the handler",
		);

		assert.ok(
			lines.some((line) => line.message === "prerendered paths with no file"),
			"startup warns about a prerendered path with no file",
		);
		assert.ok(
			lines.some(
				(line) =>
					line.message === "request" &&
					line["http.url"] === "/cpu" &&
					line["http.status_code"] === 200,
			),
			"the access log has the static hit",
		);

		assert.equal(await (await fetch(new URL("/linger", base))).text(), "lingering");

		const events = await request(new URL("/events", base).href);
		const firstEvent = await new Promise<string>((resolve) => {
			events.once("data", (chunk: Buffer) => resolve(chunk.toString()));
		});
		assert.equal(firstEvent, "data: hello\n\n");
		const eventsEnded = new Promise<void>((resolve) => {
			events.once("end", resolve);
			events.resume();
		});
		// Why no await: `/late` answers after the drain deadline.
		request(new URL("/late", base).href).catch(() => {});
		const stuck = await request(new URL("/stuck", base).href);
		const stuckEnded = new Promise<void>((resolve) => {
			stuck.once("close", resolve);
			stuck.resume();
		});
		// Why 10 s: the fixture's drain deadline is 3 s.
		const exitCode = exited(child, 10_000);
		child.kill("SIGTERM");
		assert.equal(
			await exitCode,
			0,
			"shutdown ends the event stream, closes stuck and late bodies at the deadline, and exits without waiting for the app's timers",
		);
		await Promise.all([eventsEnded, stuckEnded]);
		process.stdout.write(`ok ${runtime}\n`);
	} finally {
		child.kill("SIGKILL");
	}
}

/** `app-server start` on Node: Ctrl+C stops the server at once, though the app left a timer. */
async function checkStart(): Promise<void> {
	const { child, url } = startServer("node", [cliPath, "start", "--port", "0"], {
		cwd: devDirectory,
		env: { HOST: "127.0.0.1" },
	});
	try {
		const page = await fetch(new URL("/", await url));
		assert.equal(await page.text(), "rendered");
		const exitCode = exited(child, 5_000);
		child.kill("SIGINT");
		assert.equal(await exitCode, 0, "`start` exits without waiting for the app's timers");
		process.stdout.write("ok node start\n");
	} finally {
		child.kill("SIGKILL");
	}
}

const selected = process.argv.slice(2);
for (const runtime of selected.length > 0 ? selected : Object.keys(commands)) {
	await check(runtime);
	if (runtime === "node") {
		await checkStart();
	}
}
