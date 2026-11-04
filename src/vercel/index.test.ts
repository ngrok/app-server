import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createServer } from "../core/create-server.js";
import { createEntry } from "../core/entry.js";
import { accessLog } from "../core/plugins/access-log.js";
import { requestContext } from "../core/request-context.js";
import { heldStream, stubFramework } from "../test-server.js";
import { handler, host } from "./index.js";

let close: (() => Promise<void>) | undefined;

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

/** Serves `handler` for an app on `node:http`, as a Vercel Function does, and gives its URL. */
async function serve(): Promise<string> {
	const app = createServer({ plugins: [] });
	app.get("/whoami", (context) =>
		context.json({ url: context.req.url, client: requestContext()?.clientAddress }),
	);
	const entry = createEntry({
		app,
		host,
		clientDirectory: "/nonexistent",
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
			createEntry({ app, host, clientDirectory: "/nonexistent", framework: () => stubFramework() }),
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
			createEntry({ app, host, clientDirectory: "/nonexistent", framework: () => stubFramework() }),
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
				clientDirectory: "/nonexistent",
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
			createEntry({ app, host, clientDirectory: "/nonexistent", framework: () => stubFramework() }),
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

describe("host", () => {
	it("gives a file a new ETag for each build, also with the same size and time", async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-server-vercel-files-"));
		onTestFinished(() => {
			rmSync(directory, { recursive: true, force: true });
		});
		// Why one time: the deploy gives each file of the function one fixed time.
		const deployed = new Date(1_540_000_000_000);
		const etag = async (text: string, builtAt: string): Promise<string | null> => {
			writeFileSync(join(directory, "robots.txt"), text);
			utimesSync(join(directory, "robots.txt"), deployed, deployed);
			vi.stubEnv("APP_SERVER_BUILT_AT", builtAt);
			const entry = createEntry({
				app: createServer(),
				host,
				clientDirectory: directory,
				framework: () => stubFramework(),
			});
			const response = await entry.fetch(new Request("http://localhost/robots.txt"), {});
			await response.text();
			return response.headers.get("ETag");
		};

		const first = await etag("Disallow: /a", "1762000000000");
		const second = await etag("Disallow: /b", "1762000100000");

		expect(first).toMatch(/^W\//u);
		expect(second).not.toBe(first);
	});
});
