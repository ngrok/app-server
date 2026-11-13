import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createServer } from "../core/create-server.js";
import { createEntry } from "../core/entry.js";
import type { AppServerEntry } from "../core/entry.js";
import { withHeaderHook } from "../core/header-hook.js";
import { accessLog } from "../core/plugins/access-log.js";
import { requestId } from "../core/plugins/request-id.js";
import { securityHeaders } from "../core/plugins/security-headers.js";
import { requestContext } from "../core/request-context.js";
import type { Plugin } from "../core/types.js";
import { heldStream, stubFramework } from "../test-server.js";
import { brotliOnlyOpen } from "./brotli-only.js";
import { handler, host } from "./index.js";
import { vercel } from "./vite.js";

let close: (() => Promise<void>) | undefined;

/** A client build with no files. Why not a path to nothing: the server then warns on stdout, and a function always holds its client build. */
const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-vercel-"));

/** The access log line in the stdout `output`, or `undefined` when there is none. */
function requestLine(output: string): unknown {
	return output
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line): unknown => JSON.parse(line))
		.find(
			(line) =>
				typeof line === "object" && line != null && "message" in line && line.message === "request",
		);
}

afterEach(async () => {
	await close?.();
	close = undefined;
});

afterAll(() => {
	rmSync(clientDirectory, { recursive: true, force: true });
});

/** Serves `handler` for an app on `node:http`, as a Vercel Function does, and gives its URL. */
async function serve(plugins: Plugin[] = []): Promise<string> {
	const app = createServer({ plugins });
	app.get("/whoami", (context) =>
		context.json({ url: context.req.url, client: requestContext()?.clientAddress }),
	);
	const entry = createEntry({
		app,
		host,
		clientDirectory,
		framework: () => stubFramework(),
	});
	const listener = handler(entry);
	const server = createHttpServer((incoming, outgoing) => {
		void listener(incoming, outgoing);
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	close = async () =>
		new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("handler", () => {
	it("sends the headers of the header hooks with a HEAD response", async () => {
		const base = await serve([requestId(), securityHeaders()]);

		const response = await fetch(`${base}/whoami`, { method: "HEAD" });

		expect(response.headers.has("X-Request-Id")).toBe(true);
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("runs each header hook in the request's context", async () => {
		const echoesId: Plugin = {
			name: "echoes-id",
			middleware: async (context, next) =>
				withHeaderHook(context, next, (headers) => {
					headers.set("X-Context-Id", requestContext()?.requestId ?? "none");
				}),
		};
		const url = await serve([requestId(), echoesId]);

		const response = await fetch(`${url}/whoami`, { headers: { "X-Request-Id": "abc-123" } });
		await response.text();

		expect(response.headers.get("X-Context-Id")).toBe("abc-123");
	});

	it("takes the scheme and the client address from the headers that Vercel sets", async () => {
		const base = await serve();

		const response = await fetch(`${base}/whoami?q=1`, {
			headers: { "X-Forwarded-Proto": "https", "X-Real-IP": "203.0.113.7" },
		});

		await expect(response.json()).resolves.toStrictEqual({
			url: `${base.replace(/^http:/u, "https:")}/whoami?q=1`,
			client: "203.0.113.7",
		});
	});

	it("writes the log lines of a request before it returns", async () => {
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		onTestFinished(() => {
			write.mockRestore();
		});
		const app = createServer({ plugins: [] });
		app.get("/hello", (context) => {
			requestContext()?.logger.info("hello");
			return context.text("hi");
		});
		const listener = handler(
			createEntry({ app, host, clientDirectory, framework: () => stubFramework() }),
		);
		const written = Promise.withResolvers<string>();
		const server = createHttpServer((incoming, outgoing) => {
			void listener(incoming, outgoing).finally(() => {
				written.resolve(write.mock.calls.join(""));
			});
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		onTestFinished(async () => {
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		});

		await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hello`);

		await expect(written.promise).resolves.toContain('"message":"hello"');
	});

	it("writes the access log line of a request before it returns", async () => {
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		onTestFinished(() => {
			write.mockRestore();
		});
		const app = createServer({ plugins: [accessLog()] });
		const listener = handler(
			createEntry({ app, host, clientDirectory, framework: () => stubFramework() }),
		);
		const written = Promise.withResolvers<string>();
		const server = createHttpServer((incoming, outgoing) => {
			void listener(incoming, outgoing).finally(() => {
				written.resolve(write.mock.calls.join(""));
			});
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		onTestFinished(async () => {
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		});

		const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/page`);
		await response.text();

		expect(requestLine(await written.promise)).toMatchObject({ "network.bytes_written": 8 });
	});

	it("returns, with the access log line, when the client leaves during a streamed body", async () => {
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		onTestFinished(() => {
			write.mockRestore();
		});
		const app = createServer({ plugins: [accessLog()] });
		const listener = handler(
			createEntry({
				app,
				host,
				clientDirectory,
				framework: () => stubFramework(async () => heldStream("shell").response),
			}),
		);
		const written = Promise.withResolvers<string>();
		const server = createHttpServer((incoming, outgoing) => {
			void listener(incoming, outgoing).finally(() => {
				written.resolve(write.mock.calls.join(""));
			});
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		onTestFinished(async () => {
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		});

		const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/page`);
		const reader = response.body?.getReader();
		await reader?.read();
		await reader?.cancel();

		expect(requestLine(await written.promise)).toMatchObject({
			"network.bytes_written": 5,
			"http.client_aborted": true,
		});
	});

	it("returns after stdout takes the log lines that wait in its queue", async () => {
		const drain = Promise.withResolvers<() => void>();
		vi.spyOn(process.stdout, "write").mockImplementation((...parts: unknown[]) => {
			const callback = parts.find((part) => typeof part === "function");
			if (callback != null) {
				drain.resolve(callback as () => void);
			}
			return true;
		});
		vi.spyOn(process.stdout, "writableLength", "get").mockReturnValue(1);
		onTestFinished(() => {
			vi.restoreAllMocks();
		});
		const app = createServer({ plugins: [] });
		app.get("/hello", (context) => {
			requestContext()?.logger.info("hello");
			return context.text("hi");
		});
		const listener = handler(
			createEntry({ app, host, clientDirectory, framework: () => stubFramework() }),
		);
		let returned = false;
		const finished = Promise.withResolvers<undefined>();
		const server = createHttpServer((incoming, outgoing) => {
			void listener(incoming, outgoing).finally(() => {
				returned = true;
				finished.resolve(undefined);
			});
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		onTestFinished(async () => {
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		});

		await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hello`);
		await Promise.race([drain.promise, finished.promise]);

		expect(returned).toBe(false);
		(await drain.promise)();
		await finished.promise;
		expect(returned).toBe(true);
	});

	it("renders with the framework when no route answers", async () => {
		const base = await serve();

		const response = await fetch(`${base}/about`);

		await expect(response.text()).resolves.toBe("rendered");
	});
});

/**
 * Builds the client build `files` with `vercel()`, and gives the client build
 * of the function. Each file of the function gets one fixed time, as in a
 * deploy.
 */
function deploy(site: string, files: Readonly<Record<string, string | Uint8Array>>): string {
	const client = join(site, "build/client");
	for (const [file, body] of Object.entries(files)) {
		mkdirSync(dirname(join(client, file)), { recursive: true });
		writeFileSync(join(client, file), body);
	}
	mkdirSync(join(site, "build/server"), { recursive: true });
	writeFileSync(join(site, "build/server/app-server.js"), "export {};\n");
	vercel().output?.({
		root: site,
		clientDirectory: client,
		entryFile: join(site, "build/server/app-server.js"),
		assetsPath: "/assets/",
		logger: { info: () => {}, warn: () => {} },
	});
	const deployed = join(site, ".vercel/output/functions/index.func/build/client");
	const time = new Date(1_540_000_000_000);
	for (const entry of readdirSync(deployed, { recursive: true, withFileTypes: true })) {
		utimesSync(join(entry.parentPath, entry.name), time, time);
	}
	return deployed;
}

/** The entry of a function whose client build is `directory`. */
function functionEntry(directory: string): AppServerEntry {
	return createEntry({
		app: createServer(),
		host,
		clientDirectory: directory,
		framework: () => stubFramework(),
	});
}

describe("host", () => {
	it("gives a file a new ETag for each build, also with the same bytes and the same time on disk", async () => {
		const site = mkdtempSync(join(tmpdir(), "app-server-vercel-files-"));
		vi.useFakeTimers({ toFake: ["Date"], now: 1_762_000_000_000 });
		onTestFinished(() => {
			vi.useRealTimers();
			rmSync(site, { recursive: true, force: true });
		});
		const etag = async (): Promise<string | null> => {
			const entry = functionEntry(deploy(site, { "robots.txt": "Disallow: /a" }));
			const response = await entry.fetch(new Request("http://localhost/robots.txt"), {});
			await response.text();
			return response.headers.get("ETag");
		};

		const first = await etag();
		vi.setSystemTime(1_762_000_100_000);
		const second = await etag();

		expect(first).toMatch(/^W\//u);
		expect(second).not.toBe(first);
	});

	it("serves the files that the build listed: a file, a directory index, and a file that the function keeps only as a brotli copy", async () => {
		const site = mkdtempSync(join(tmpdir(), "app-server-vercel-listed-"));
		onTestFinished(() => {
			rmSync(site, { recursive: true, force: true });
		});
		const page = `<h1>Blog</h1>${"<p>post</p>".repeat(200)}`;
		const text = "0123456789".repeat(200);
		const directory = deploy(site, {
			"robots.txt": "Disallow: /a",
			"about/index.html": "<h1>About</h1>",
			"blog/index.html": page,
			"blog/.index.html.br": brotliCompressSync(page),
			"notes.txt": text,
			".notes.txt.br": brotliCompressSync(text),
		});
		// Why: the function serves the files of the list, so it does not find a later file.
		writeFileSync(join(directory, "late.txt"), "late");
		const entry = functionEntry(directory);
		const request = async (path: string, headers: Record<string, string> = {}) =>
			entry.fetch(new Request(`http://localhost${path}`, { headers }), {});

		const file = await request("/robots.txt");
		const index = await request("/about");
		const brotli = await request("/blog", { "Accept-Encoding": "br" });
		const plain = await request("/blog", { "Accept-Encoding": "identity" });
		const range = await request("/notes.txt", {
			"Accept-Encoding": "identity",
			Range: "bytes=3-6",
		});
		const list = await request("/.app-server-files.json");
		const missing = await request("/missing.txt");
		const late = await request("/late.txt");

		expect({
			file: [file.headers.get("Content-Length"), await file.text()],
			index: await index.text(),
			brotli: [brotli.headers.get("Content-Encoding"), Buffer.from(await brotli.arrayBuffer())],
			plain: [plain.headers.get("Content-Length"), await plain.text()],
			range: [range.status, await range.text()],
			list: await list.text(),
			missing: await missing.text(),
			late: await late.text(),
		}).toStrictEqual({
			file: ["12", "Disallow: /a"],
			index: "<h1>About</h1>",
			brotli: ["br", brotliCompressSync(page)],
			plain: [String(page.length), page],
			range: [206, "3456"],
			list: "rendered",
			missing: "rendered",
			late: "rendered",
		});
	});

	it("reads a client build with no list from the file system, as the build step and development do", async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-server-vercel-no-list-"));
		onTestFinished(() => {
			rmSync(directory, { recursive: true, force: true });
		});
		mkdirSync(join(directory, "about"));
		writeFileSync(join(directory, "about/index.html"), "<h1>About</h1>");
		const files = host.files(directory);

		const before = await files.stat("/robots.txt");
		writeFileSync(join(directory, "robots.txt"), "Disallow: /a");
		const response = await functionEntry(directory).fetch(
			new Request("http://localhost/about"),
			{},
		);

		expect(before).toBeUndefined();
		await expect(files.stat("/robots.txt")).resolves.toMatchObject({ kind: "file", size: 12 });
		await expect(response.text()).resolves.toBe("<h1>About</h1>");
	});

	it("opens the brotli copy of a file only when the body is read, and cancels it with the body", async () => {
		const compressed = brotliCompressSync("a".repeat(4096));
		let opens = 0;
		let cancels = 0;
		const open = brotliOnlyOpen(
			async () => {
				opens += 1;
				return new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(compressed);
					},
					cancel() {
						cancels += 1;
					},
				});
			},
			new Set(["/page.html"]),
		);

		const reader = (await open("/page.html")).getReader();
		const unread = opens;
		const first = await reader.read();
		await reader.cancel();

		expect({ unread, first: first.value?.byteLength }).toStrictEqual({ unread: 0, first: 4096 });
		// Why poll: the pipe cancels its source after the cancel returns.
		await vi.waitFor(() => {
			expect(cancels).toBe(1);
		});
	});
});
