// Runs the built CLI on Node, Bun, and Deno against one fixture and checks the same behavior on
// each: `node ./test/runtimes.ts [node|bun|deno ...]`. Build the package first. A runtime that is
// not installed fails the run, so CI cannot pass by skipping one.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { get } from "node:http";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { join } from "node:path";
import { constants, createGunzip } from "node:zlib";

const packageDirectory = join(import.meta.dirname, "..");
const serveArgs = ["dist/cli.js", "serve", "test/fixtures/runtime-entry.js"];
const portArgs = ["dist/cli.js", "serve", "test/fixtures/port-entry.js"];
const devDirectory = join(import.meta.dirname, "fixtures/dev");
const reactRouterDirectory = join(import.meta.dirname, "fixtures/react-router");
const tanstackStartDirectory = join(import.meta.dirname, "fixtures/tanstack-start");
const binDirectory = join(import.meta.dirname, "../node_modules/.bin");
const cliPath = join(import.meta.dirname, "../dist/cli.js");
const commands: Record<string, (args: string[]) => [string, string[]]> = {
	node: (args) => ["node", args],
	bun: (args) => ["bun", args],
	deno: (args) => [
		"deno",
		[
			"run",
			"--allow-net",
			"--allow-env",
			"--allow-read",
			"--allow-sys",
			// Why: in `start`, Vite loads its native bundler and writes its cache. On Linux, Vite also
			// reads a WSL file that Deno gives only to `--allow-all`, so Deno ignores that read.
			...(args.includes("start")
				? ["--allow-ffi", "--allow-write", "--ignore-read=/proc/sys/fs/binfmt_misc/WSLInterop"]
				: []),
			...args,
		],
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
			// Why the filter: Vite in `start` and the fixture at shutdown write lines that are not JSON.
			for (const part of parts.filter((candidate) => candidate.startsWith("{"))) {
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

async function request(
	url: string,
	headers: Record<string, string> = {},
): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		get(url, { headers }, resolve).once("error", reject);
	});
}

/** The exit code, or a rejection when the child runs past `ms`, so a hang fails the run. */
async function exited(child: ChildProcess, ms: number): Promise<number | null> {
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

async function waitFor(isDone: () => Promise<boolean>, what: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (await isDone()) {
			return;
		}
		await new Promise((resolve) => {
			setTimeout(resolve, 100);
		});
	}
	throw new Error(`Timed out: ${what}`);
}

/** Listens on an open port on 127.0.0.1 and resolves with the server and its port. */
async function holdPort(): Promise<{ server: Server; port: number }> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve({ server, port: typeof address === "object" && address != null ? address.port : 0 });
		});
	});
}

async function close(server: Server): Promise<void> {
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
		assert.match(page.headers.get("etag") ?? "", /^W\//u);

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
			gunzip.once("data", (chunk: Buffer) => {
				resolve(chunk.toString());
			});
		});
		assert.equal(shell, "<html>shell", "the first gzip chunk arrives before the stream ends");
		await (await fetch(new URL("/release", base))).text();

		const held = await request(new URL("/hold", base).href);
		await new Promise<void>((resolve) => {
			held.once("data", () => {
				resolve();
			});
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
			events.once("data", (chunk: Buffer) => {
				resolve(chunk.toString());
			});
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
		const stdoutEnded = new Promise<void>((resolve) => {
			child.stdout.once("end", resolve);
		});
		// Why 10 s: the fixture's drain deadline is 3 s.
		const exitCode = exited(child, 10_000);
		child.kill("SIGTERM");
		assert.equal(
			await exitCode,
			0,
			"shutdown ends the event stream, closes stuck and late bodies at the deadline, and exits without waiting for the app's timers",
		);
		await Promise.all([eventsEnded, stuckEnded, stdoutEnded]);
		assert.ok(
			lines.some((line) => line.message === "stopped"),
			"the exit waits for stdout, so the last log line arrives",
		);
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

/** Builds the framework fixture apps with the built package, as an app's build does. */
function buildFixtures(): void {
	execFileSync(`${binDirectory}/react-router`, ["build"], {
		cwd: reactRouterDirectory,
		stdio: ["ignore", "ignore", "inherit"],
	});
	execFileSync(`${binDirectory}/vite`, ["build"], {
		cwd: tanstackStartDirectory,
		stdio: ["ignore", "ignore", "inherit"],
	});
}

/** The first chunk of a response body, and the whole body. */
async function chunks(url: string, headers: Record<string, string> = {}) {
	const response = await request(url, headers);
	const parts: string[] = [];
	await new Promise<void>((resolve, reject) => {
		response.on("data", (chunk: Buffer) => {
			parts.push(chunk.toString());
		});
		response.once("end", resolve);
		response.once("error", reject);
	});
	return { response, first: parts[0] ?? "", body: parts.join("") };
}

/** Checks what each framework app shares: a prerendered page and a resource with its build headers. */
async function checkFrameworkShared(base: string, title: string): Promise<void> {
	const page = await fetch(new URL("/", base));
	assert.equal(page.status, 200);
	assert.match(await page.text(), new RegExp(title, "u"), "the prerendered page answers");
	assert.match(page.headers.get("etag") ?? "", /^W\//u, "the prerendered page comes from its file");

	const hello = await fetch(new URL("/hello.txt", base));
	assert.equal(await hello.text(), "hello");
	assert.equal(hello.headers.get("cache-control"), "max-age=60", "the build's headers replay");
	assert.equal(hello.headers.get("content-type"), "text/plain; charset=utf-8");

	const whoami = await fetch(new URL("/whoami", base), { headers: { "X-Request-Id": "abc-123" } });
	assert.deepEqual(
		await whoami.json(),
		{ fromContext: "abc-123", fromStorage: "abc-123" },
		"the framework and requestContext() get the request ID",
	);
	assert.equal(await (await fetch(new URL("/livez", base))).text(), "ok", "the app's routes run");
}

/** Stops a server with SIGTERM and checks that it exits cleanly. */
async function stopCleanly(child: ChildProcess, what: string): Promise<void> {
	const exitCode = exited(child, 10_000);
	child.kill("SIGTERM");
	assert.equal(await exitCode, 0, `${what} shuts down cleanly`);
}

/** The React Router fixture app: built with the Vite plugin, served by `app-server serve`. */
async function checkReactRouter(runtime: string): Promise<void> {
	const { child, url } = startServer(runtime, [cliPath, "serve"], { cwd: reactRouterDirectory });
	try {
		const base = await url;
		await checkFrameworkShared(base, "React Router home");
		const data = await fetch(new URL("/hello.txt.data", base));
		assert.equal(
			data.headers.get("content-type"),
			"text/x-script",
			"a .data file replays its type",
		);
		await data.text();
		await stopCleanly(child, "the React Router app");
		process.stdout.write(`ok ${runtime} react-router\n`);
	} finally {
		child.kill("SIGKILL");
	}
}

/** The TanStack Start fixture app: built with the Vite plugin, served by `app-server serve`. */
async function checkTanstackStart(runtime: string): Promise<void> {
	const { child, url } = startServer(runtime, [cliPath, "serve"], { cwd: tanstackStartDirectory });
	try {
		const base = await url;
		await checkFrameworkShared(base, "TanStack Start home");

		const home = await (await fetch(new URL("/", base))).text();
		const serverFn = /id="server-fn" href="(?<path>[^"]+)"/u.exec(home)?.groups?.path ?? "";
		// Why these headers: a browser sends them, and Start's CSRF check needs one of them.
		const called = await fetch(new URL(serverFn, base), {
			headers: { "Sec-Fetch-Site": "same-origin", "X-Tsr-ServerFn": "true" },
		});
		assert.equal(called.status, 200, "a server function answers through the pipeline");
		assert.match(await called.text(), /hello from a server function/u);

		const stream = await chunks(new URL("/stream", base).href);
		assert.match(stream.first, /<h1>shell/u, "the shell arrives first");
		assert.doesNotMatch(stream.first, /streamed late/u, "the shell arrives before the slow part");
		assert.match(stream.body, /streamed late/u, "the slow part streams after the shell");

		await stopCleanly(child, "the TanStack Start app");
		process.stdout.write(`ok ${runtime} tanstack-start\n`);
	} finally {
		child.kill("SIGKILL");
	}
}

/** `app-server start` on the TanStack Start fixture: SSR, a Vite module, and HMR on one port. */
async function checkTanstackStartDev(runtime: string): Promise<void> {
	const { child, url } = startServer(runtime, [cliPath, "start", "--port", "0"], {
		cwd: tanstackStartDirectory,
		env: { HOST: "127.0.0.1" },
	});
	try {
		const base = await url;
		assert.match(await (await fetch(new URL("/", base))).text(), /TanStack Start home/u);
		const client = await fetch(new URL("/@vite/client", base));
		assert.match(client.headers.get("content-type") ?? "", /javascript/u, "Vite serves its client");
		await client.text();
		const hmr = await new Promise<string>((resolve, reject) => {
			const socket = new WebSocket(base.replace(/^http/u, "ws"), "vite-hmr");
			socket.addEventListener("message", (event) => {
				resolve(String(event.data));
				socket.close();
			});
			socket.addEventListener("error", () => {
				reject(new Error("The HMR socket failed."));
			});
		});
		assert.match(hmr, /"type":"connected"/u, "HMR connects on the server's port");
		const exitCode = exited(child, 10_000);
		child.kill("SIGINT");
		assert.equal(await exitCode, 0, "`start` stops cleanly");
		process.stdout.write(`ok ${runtime} tanstack-start start\n`);
	} finally {
		child.kill("SIGKILL");
	}
}

buildFixtures();
const selected = process.argv.slice(2);
for (const runtime of selected.length > 0 ? selected : Object.keys(commands)) {
	await check(runtime);
	if (runtime === "node") {
		await checkStart();
	}
	await checkReactRouter(runtime);
	await checkTanstackStart(runtime);
	await checkTanstackStartDev(runtime);
}
