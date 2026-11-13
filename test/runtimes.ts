// Runs the built CLI on Node, Bun, and Deno against one fixture and checks the same behavior on
// each: `node ./test/runtimes.ts [node|bun|deno ...]`. Build the package first. A runtime that is
// not installed fails the run, so CI cannot pass by skipping one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { get } from "node:http";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	brotliDecompressSync,
	constants,
	createBrotliDecompress,
	createGunzip,
	gunzipSync,
} from "node:zlib";
import { buildFixtures, commands, startServer } from "./harness.ts";

const serveArgs = ["dist/cli.js", "serve", "test/fixtures/runtime-entry.js"];
const portArgs = ["dist/cli.js", "serve", "test/fixtures/port-entry.js"];
const devDirectory = join(import.meta.dirname, "fixtures/dev");
const reactRouterDirectory = join(import.meta.dirname, "fixtures/react-router");
const tanstackStartDirectory = join(import.meta.dirname, "fixtures/tanstack-start");
const binDirectory = join(import.meta.dirname, "../node_modules/.bin");
const cliPath = join(import.meta.dirname, "../dist/cli.js");

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
	const { child, lines, url } = startServer(runtime, serveArgs);
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

		const range = await fetch(new URL("/assets/app-abc123.js", base), {
			headers: { Range: "bytes=0-5" },
		});
		assert.equal(range.status, 206, "a byte range gets a 206");
		assert.equal(await range.text(), "export");

		const upload = async (bytes: number, { streamed }: { streamed: boolean }) => {
			const body = new Uint8Array(bytes);
			// Why `duplex`: a request with a stream body needs it, and the DOM types lack it.
			const init: RequestInit & { duplex: "half" } = {
				method: "POST",
				body: streamed ? new Blob([body]).stream() : body,
				duplex: "half",
			};
			const response = await fetch(new URL("/upload", base), init);
			return { status: response.status, text: await response.text() };
		};
		assert.deepEqual(await upload(1024, { streamed: true }), { status: 200, text: "1024" });
		assert.equal((await upload(2048, { streamed: false })).status, 413, "a large body gets a 413");
		assert.equal(
			(await upload(2048, { streamed: true })).status,
			413,
			"a large streamed body gets a 413",
		);

		// The stream sends its shell and holds the rest until `/release`, so this read hangs if
		// compression holds the stream back.
		const decoders = {
			gzip: () => createGunzip({ flush: constants.Z_SYNC_FLUSH }),
			br: () => createBrotliDecompress({ flush: constants.BROTLI_OPERATION_FLUSH }),
		};
		for (const [encoding, decoder] of Object.entries(decoders)) {
			// oxlint-disable-next-line no-await-in-loop -- each check holds one stream of the fixture.
			const streamed = await request(new URL("/stream", base).href, {
				"Accept-Encoding": encoding,
			});
			assert.equal(streamed.headers["content-encoding"], encoding);
			const decoded = streamed.pipe(decoder());
			// oxlint-disable-next-line no-await-in-loop -- each check holds one stream of the fixture.
			const shell = await new Promise<string>((resolve) => {
				decoded.once("data", (chunk: Buffer) => {
					resolve(chunk.toString());
				});
			});
			assert.equal(
				shell,
				"<html>shell",
				`the first ${encoding} chunk arrives before the stream ends`,
			);
			// oxlint-disable-next-line no-await-in-loop -- each check holds one stream of the fixture.
			await (await fetch(new URL("/release", base))).text();
		}

		// Why twice: the second page of each encoding gets a pooled stream, which must give the same bytes.
		for (const [encoding, decode] of [
			["br", brotliDecompressSync],
			["gzip", gunzipSync],
		] as const) {
			const bodies: Buffer[] = [];
			for (let index = 0; index < 2; index += 1) {
				// oxlint-disable-next-line no-await-in-loop -- the second request must find the stream of the first in the pool.
				const pooled = await request(new URL("/page", base).href, { "Accept-Encoding": encoding });
				assert.equal(pooled.headers["content-encoding"], encoding);
				// oxlint-disable-next-line no-await-in-loop -- the second request must find the stream of the first in the pool.
				bodies.push(Buffer.concat(await pooled.toArray()));
			}
			assert.equal(decode(bodies[0] ?? Buffer.alloc(0)).toString(), "<p>page</p>".repeat(200));
			assert.deepEqual(bodies[1], bodies[0], `a pooled ${encoding} stream gives the same bytes`);
		}

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
		assert.ok(
			lines.some(
				(line) =>
					line.message === "request" &&
					line["http.url"] === "/unknown" &&
					line["sent.request_id"] === "abc-123",
			),
			"the access log's `attributes` gets the headers that went out",
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
		const stopped = lines.findIndex((line) => line.message === "stopped");
		assert.notEqual(stopped, -1, "the exit waits for stdout, so the last log line arrives");
		const warned = lines.findIndex(
			(line) => line.message === "the drain deadline passed with open requests",
		);
		assert.ok(
			warned !== -1 && warned < stopped && lines[warned]?.["app_server.deadline_ms"] === 3_000,
			"a warn line names the drain deadline that cut open requests, before `stopped`",
		);
		// Why not on Bun: on Bun 1.3, `stop(true)` does not end an open body, so its access line never comes.
		if (runtime !== "bun") {
			const cut = lines.findIndex(
				(line) => line.message === "request" && line["http.url"] === "/stuck",
			);
			assert.ok(
				cut !== -1 && cut < stopped && lines[cut]?.["http.client_aborted"] === true,
				"the access line of a response that the deadline cuts comes before `stopped`",
			);
		}
		process.stdout.write(`ok ${runtime}\n`);
	} finally {
		child.kill("SIGKILL");
	}
}

/**
 * `app-server start` on Node: a Vite plugin gets the HTTP server's events, and Ctrl+C stops the
 * server at once, though the app left a timer.
 */
async function checkStart(): Promise<void> {
	const { child, url, lines } = startServer("node", [cliPath, "start", "--port", "0"], {
		cwd: devDirectory,
		env: { HOST: "127.0.0.1" },
	});
	try {
		const page = await fetch(new URL("/", await url));
		assert.equal(await page.text(), "rendered");
		// Why: the `exit` event can come before the last stdout line.
		const stdoutEnded = new Promise<void>((resolve) => {
			child.stdout.once("end", resolve);
		});
		const exitCode = exited(child, 5_000);
		child.kill("SIGINT");
		assert.equal(await exitCode, 0, "`start` exits without waiting for the app's timers");
		await stdoutEnded;
		assert.deepEqual(
			lines.map((line) => line.message).filter((message) => message.startsWith("vite plugin")),
			["vite plugin saw listening", "vite plugin saw close"],
			"a Vite plugin gets the HTTP server's events",
		);
		assert.deepEqual(
			lines.filter((line) => line.message === "upgrade listeners").map((line) => line.upgrades),
			[1],
			"the HTTP server has only the HMR `upgrade` listener, because a Vite restart does not remove a proxy's",
		);
		process.stdout.write("ok node start\n");
	} finally {
		child.kill("SIGKILL");
	}
}

/**
 * The source of a script that imports the module at the URL `module`. It then writes each module
 * specifier that the process resolved, with `import` or `require`, as one log line.
 */
function resolveLogScript(module: string): string {
	return [
		'import { registerHooks } from "node:module";',
		"const specifiers = [];",
		"registerHooks({",
		"\tresolve(specifier, context, nextResolve) {",
		"\t\tspecifiers.push(specifier);",
		"\t\treturn nextResolve(specifier, context);",
		"\t},",
		"});",
		`await import(${JSON.stringify(module)});`,
		'console.log(JSON.stringify({ level: "info", message: "resolved", specifiers }));',
	].join("\n");
}

/** What a process loads on Node: no module that only another command or a rare build uses. */
async function checkLoadedModules(): Promise<void> {
	const plugin = pathToFileURL(join(import.meta.dirname, "../dist/vite.js")).href;
	const { specifiers }: { specifiers: string[] } = JSON.parse(
		execFileSync("node", ["--input-type=module", "-e", resolveLogScript(plugin)], {
			encoding: "utf8",
		}),
	);
	assert.ok(specifiers.includes(plugin), "the script records each specifier");
	assert.deepEqual(
		specifiers.filter((specifier) => specifier.startsWith("@vercel/nft")),
		[],
		"the import of the Vite plugin does not load the tracer, which only a build that removes files uses",
	);

	// Why the React Router app: its build holds its own copy of the server, as each build from the
	// `appServer` plugin does.
	const { child, lines, url } = startServer(
		"node",
		["--input-type=module", "-e", resolveLogScript(pathToFileURL(cliPath).href), "serve"],
		{ cwd: reactRouterDirectory },
	);
	try {
		await url;
		const resolved = (): string[] | undefined => {
			const logged = lines.find((line) => line.message === "resolved")?.specifiers;
			return Array.isArray(logged) ? logged.map(String) : undefined;
		};
		await waitFor(async () => resolved() != null, "`serve` returns after the server listens");
		assert.deepEqual(
			resolved()?.filter((specifier) => /^@?hono(?:\/|$)/u.test(specifier)),
			[],
			"`serve` loads no server of the CLI's copy for a build that has its own",
		);
		await stopCleanly(child, "the React Router app under the script");
		process.stdout.write("ok node loaded modules\n");
	} finally {
		child.kill("SIGKILL");
	}
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

/** The URL path of the copy that the build writes for the file at `path`, such as `.app.js.br`. */
function copyPath(path: string, extension: "br" | "gz"): string {
	return path.replace(/[^/]*$/u, (name) => `.${name}.${extension}`);
}

/** Checks what each framework app shares: a prerendered page and a resource with its build headers. */
async function checkFrameworkShared(
	base: string,
	title: string,
	clientDirectory: string,
): Promise<void> {
	const page = await fetch(new URL("/", base));
	assert.equal(page.status, 200);
	const html = await page.text();
	assert.match(html, new RegExp(title, "u"), "the prerendered page answers");
	assert.match(page.headers.get("etag") ?? "", /^W\//u, "the prerendered page comes from its file");

	const scripts = [...html.matchAll(/"(?<path>\/assets\/[^"]+\.js)"/gu)].map(
		(match) => match.groups?.path ?? "",
	);
	for (const [extension, accept] of [
		["gz", "gzip"],
		["br", "gzip, br"],
	] as const) {
		const withCopy = scripts.filter((path) =>
			existsSync(join(clientDirectory, copyPath(path, extension))),
		);
		// oxlint-disable-next-line no-await-in-loop -- one encoding at a time keeps a failure readable.
		const fromCopy = await Promise.all(
			withCopy.map(async (path) => {
				const response = await request(new URL(path, base).href, { "Accept-Encoding": accept });
				const parts: Buffer[] = [];
				for await (const part of response) {
					parts.push(Buffer.from(part as Uint8Array));
				}
				return Buffer.concat(parts).equals(
					readFileSync(join(clientDirectory, copyPath(path, extension))),
				);
			}),
		);
		assert.ok(
			fromCopy.length > 0 && fromCopy.every(Boolean),
			`each script with a ${extension} copy from the build sends that copy for "${accept}"`,
		);
	}

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
	assert.equal(await (await fetch(new URL("/ping", base))).text(), "pong", "the app's routes run");
	assert.equal(await (await fetch(new URL("/livez", base))).text(), "ok", "the probes answer");

	const manifest: unknown = JSON.parse(
		readFileSync(join(clientDirectory, ".app-server.json"), "utf8"),
	);
	const buildId =
		typeof manifest === "object" && manifest != null && "buildId" in manifest
			? String(manifest.buildId)
			: "";
	assert.match(buildId, /^[0-9a-f]{16}$/u, "the build writes a build ID");
	assert.equal(page.headers.get("x-build-id"), buildId, "a page sends the build's ID");
	assert.equal(
		page.headers.get("server-timing"),
		`build;desc="${buildId}"`,
		"the stale-build client reads the build's ID",
	);
}

/** Stops a server with SIGTERM and checks that it exits cleanly. */
async function stopCleanly(child: ChildProcess, what: string): Promise<void> {
	const exitCode = exited(child, 10_000);
	child.kill("SIGTERM");
	assert.equal(await exitCode, 0, `${what} shuts down cleanly`);
}

/** The React Router fixture app: built with the Vite plugin, served by `app-server serve`. */
async function checkReactRouter(runtime: string): Promise<void> {
	const { child, lines, url } = startServer(runtime, [cliPath, "serve"], {
		cwd: reactRouterDirectory,
	});
	try {
		const base = await url;
		await checkFrameworkShared(
			base,
			"React Router home",
			join(reactRouterDirectory, "build/client"),
		);
		const data = await fetch(new URL("/hello.txt.data", base));
		assert.equal(
			data.headers.get("content-type"),
			"text/x-script",
			"a .data file replays its type",
		);
		await data.text();
		await stopCleanly(child, "the React Router app");
		assert.equal(
			lines.filter((line) => line.message === "listening").length,
			1,
			"`serve` starts the build once",
		);
		process.stdout.write(`ok ${runtime} react-router\n`);
	} finally {
		child.kill("SIGKILL");
	}
}

/** The script that serves a Vercel Function's handler on `node:http`, as Vercel's Node.js launcher does. */
const VERCEL_LAUNCHER = `
const { createServer } = await import("node:http");
const handler = (await import(process.argv[1])).default;
const server = createServer(handler).listen(0, "127.0.0.1", () => {
	console.log(JSON.stringify({ message: "listening", "app_server.urls": ["http://127.0.0.1:" + server.address().port] }));
});
process.once("SIGTERM", () => server.close());
`;

/**
 * The React Router fixture app built with the vercel host. The function runs
 * from a copy outside this package, so it can import only the files of the
 * function.
 */
async function checkVercel(): Promise<void> {
	execFileSync(`${binDirectory}/react-router`, ["build"], {
		cwd: reactRouterDirectory,
		env: { ...process.env, APP_SERVER_HOST: "vercel" },
		stdio: ["ignore", "ignore", "inherit"],
	});
	const output = join(reactRouterDirectory, ".vercel/output");
	const copy = mkdtempSync(join(tmpdir(), "app-server-vercel-"));
	cpSync(join(output, "functions/index.func"), copy, { recursive: true, verbatimSymlinks: true });
	const config: unknown = JSON.parse(readFileSync(join(copy, ".vc-config.json"), "utf8"));
	const handler =
		typeof config === "object" && config != null && "handler" in config
			? String(config.handler)
			: "";
	const { child, url } = startServer(
		"node",
		["--input-type=module", "-e", VERCEL_LAUNCHER, join(copy, handler)],
		{
			cwd: copy,
		},
	);
	try {
		const base = await url;
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `vercel()` of this package wrote the file.
		const { routes } = JSON.parse(readFileSync(join(output, "config.json"), "utf8")) as {
			routes: { src?: string; dest?: string; headers?: Record<string, string> }[];
		};
		const route = (src: string) => routes.find((each) => each.src === src);
		assert.equal(
			route("^/$")?.headers?.["x-content-type-options"],
			"nosniff",
			"the CDN sends the prerendered page with the pipeline's headers",
		);
		const html = readFileSync(join(output, "static", route("^/$")?.dest ?? "/none"), "utf8");
		assert.match(html, /React Router home/u, "the CDN has the prerendered page");
		assert.ok(
			existsSync(join(copy, "build/client/.index.html.br")) &&
				!existsSync(join(copy, "build/client/index.html")),
			"the function keeps only the brotli copy of the page, for a request that no CDN route matches",
		);
		const plain = await fetch(new URL("/", base), { headers: { "Accept-Encoding": "identity" } });
		assert.match(
			await plain.text(),
			/React Router home/u,
			"the function decompresses the page for a client with no brotli",
		);
		assert.equal(
			route(String.raw`^/hello\.txt$`)?.headers?.["cache-control"],
			"max-age=60",
			"the build's headers replay on the CDN",
		);
		const scripts = [...html.matchAll(/"(?<path>\/assets\/[^"]+\.js)"/gu)].map(
			(match) => match.groups?.path ?? "",
		);
		assert.ok(
			scripts.length > 0 && scripts.every((path) => existsSync(join(output, "static", path))),
			"the CDN has each script of the page",
		);
		const missing = await fetch(new URL(scripts[0] ?? "/assets/none.js", base));
		assert.equal(missing.status, 404, "the function does not carry the CDN files");
		assert.equal(missing.headers.get("cache-control"), "no-store");
		await missing.text();

		const whoami = await fetch(new URL("/whoami", base), {
			headers: { "X-Request-Id": "abc-123" },
		});
		assert.deepEqual(
			await whoami.json(),
			{ fromContext: "abc-123", fromStorage: "abc-123" },
			"the framework and requestContext() get the request ID",
		);
		assert.equal(
			await (await fetch(new URL("/ping", base))).text(),
			"pong",
			"the app's routes run",
		);
		process.stdout.write("ok node vercel\n");
	} finally {
		child.kill("SIGKILL");
		rmSync(copy, { recursive: true, force: true });
	}
}

/** The TanStack Start fixture app: built with the Vite plugin, served by `app-server serve`. */
async function checkTanstackStart(runtime: string): Promise<void> {
	const { child, lines, url } = startServer(runtime, [cliPath, "serve"], {
		cwd: tanstackStartDirectory,
	});
	try {
		const base = await url;
		await checkFrameworkShared(
			base,
			"TanStack Start home",
			join(tanstackStartDirectory, "dist/client"),
		);

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
		assert.equal(
			lines.filter((line) => line.message === "listening").length,
			1,
			"`serve` starts the build once",
		);
		process.stdout.write(`ok ${runtime} tanstack-start\n`);
	} finally {
		child.kill("SIGKILL");
	}
}

/** A framework fixture app, and the files of its build that a deploy copies. */
const standaloneApps = [
	{
		name: "react-router",
		directory: reactRouterDirectory,
		buildDirectory: "build",
		frameworkEntry: "build/server/index.js",
		title: "React Router home",
		// Why: the fixture keeps this CommonJS package in `ssr.external`, and it reads a file next to it.
		paths: { "/greeting": "hello from a copied package" },
	},
	{
		name: "tanstack-start",
		directory: tanstackStartDirectory,
		buildDirectory: "dist",
		frameworkEntry: "dist/server/server.js",
		title: "TanStack Start home",
		paths: {},
	},
];

/**
 * A fixture's build directory alone, as a deploy copies it: the runtime runs
 * `<build>/server/app-server.js` with no `npm install` and no `node_modules`
 * above it.
 */
async function checkStandalone(
	runtime: string,
	app: (typeof standaloneApps)[number],
): Promise<void> {
	const deployed = realpathSync(mkdtempSync(join(tmpdir(), "app-server-deployed-")));
	cpSync(join(app.directory, app.buildDirectory), join(deployed, app.buildDirectory), {
		recursive: true,
	});
	for (let directory = deployed; directory !== dirname(directory); directory = dirname(directory)) {
		assert.ok(!existsSync(join(directory, "node_modules")), `no node_modules above ${deployed}`);
	}
	const { child, lines, url } = startServer(
		runtime,
		[`${app.buildDirectory}/server/app-server.js`],
		{ cwd: deployed },
	);
	try {
		const base = await url;
		await checkFrameworkShared(base, app.title, join(deployed, app.buildDirectory, "client"));
		for (const [path, text] of Object.entries(app.paths)) {
			assert.equal(await (await fetch(new URL(path, base))).text(), text);
		}
		await stopCleanly(child, `the ${app.name} build alone`);
		assert.deepEqual(
			lines.map((line) => line.message).filter((message) => message !== "request"),
			["listening", "draining", "stopped"],
			"SIGTERM drains the server, and the build starts it once",
		);
		if (runtime === "node") {
			const frameworkEntry = pathToFileURL(join(deployed, app.frameworkEntry)).href;
			execFileSync("node", ["--input-type=module", "-e", `await import("${frameworkEntry}");`]);
		}
		process.stdout.write(`ok ${runtime} ${app.name} standalone\n`);
	} finally {
		child.kill("SIGKILL");
		rmSync(deployed, { recursive: true, force: true });
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
		assert.equal(
			client.headers.get("x-content-type-options"),
			"nosniff",
			"a response that Vite sends gets the security headers",
		);
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
		await checkLoadedModules();
	}
	await checkReactRouter(runtime);
	await checkTanstackStart(runtime);
	for (const app of standaloneApps) {
		await checkStandalone(runtime, app);
	}
	await checkTanstackStartDev(runtime);
}
// Why last: it builds the React Router app again, for the vercel host.
if (selected.length === 0 || selected.includes("node")) {
	await checkVercel();
}
