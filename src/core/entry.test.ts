import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { host as nodeHost } from "../node/index.js";
import { renderedFramework, stubFramework } from "../test-server.js";
import type { AppServer } from "./create-server.js";
import { createServer } from "./create-server.js";
import { createEntry } from "./entry.js";
import { buildId } from "./plugins/build-id.js";
import { prerendered } from "./plugins/static.js";
import { requestId } from "./plugins/request-id.js";
import { requestContext } from "./request-context.js";
import type { FetchHandler, HostRuntime, Listener, LogSink } from "./types.js";

const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-entry-"));
writeFileSync(
	join(clientDirectory, ".app-server.json"),
	JSON.stringify({
		buildId: "b42",
		prerendered: ["/cpu", "/gone"],
		headers: {},
		scriptHashes: {},
	}),
);
mkdirSync(join(clientDirectory, "cpu"));
writeFileSync(join(clientDirectory, "cpu/index.html"), "<h1>CPU</h1>");

afterAll(() => {
	rmSync(clientDirectory, { recursive: true, force: true });
});

/** The node host with a listener that records its fetch handler and no signal handlers. */
function testHost(): { host: HostRuntime; fetch: () => FetchHandler | undefined } {
	let handler: FetchHandler | undefined;
	const listener: Listener = {
		name: "recording",
		start: async (fetch) => {
			handler = fetch;
			return { url: "http://localhost:1/", stop: async () => {} };
		},
	};
	return {
		host: { ...nodeHost, listeners: () => [listener], lifecycle: { onStop: () => {} } },
		fetch: () => handler,
	};
}

function recordingLogger(lines: string[]): LogSink {
	return {
		log: (_level, message, attributes) => {
			lines.push(`${message} ${JSON.stringify(attributes)}`);
		},
	};
}

describe("createEntry", () => {
	it("refuses an app that is not from createServer", () => {
		const app = {} as AppServer;

		expect(() => createEntry({ app, host: nodeHost, framework: () => stubFramework() })).toThrow(
			"not from `createServer()`",
		);
	});

	it("answers a development request through the app's pipeline", async () => {
		const entry = createEntry({
			app: createServer({ plugins: [] }),
			host: nodeHost,
			framework: () => stubFramework(),
		});

		const response = await entry.fetchDev(new Request("http://localhost/"), {}, async (_, next) =>
			next(),
		);

		await expect(response.text()).resolves.toBe("rendered");
	});

	it("in development, gives a twin when the framework does not know the prerendered paths", async () => {
		const framework = stubFramework(async (request) =>
			request.url.endsWith(".md")
				? new Response("# Twin", { headers: { "Content-Type": "text/markdown" } })
				: new Response("rendered"),
		);
		const entry = createEntry({
			app: createServer({ plugins: [prerendered({ markdownTwins: true })] }),
			host: nodeHost,
			framework: () => framework,
		});

		const response = await entry.fetchDev(
			new Request("http://localhost/docs", { headers: { Accept: "text/markdown" } }),
			{},
			async (_, next) => next(),
		);

		await expect(response.text()).resolves.toBe("# Twin");
	});

	it("sends the build ID of the build manifest in production, and none in development", async () => {
		const { host, fetch } = testHost();
		const entry = (): ReturnType<typeof createEntry> =>
			createEntry({
				app: createServer({ plugins: [buildId()], logger: recordingLogger([]) }),
				host,
				clientDirectory,
				framework: () => ({ name: "stub", fetch: renderedFramework }),
			});
		const production = entry();
		const development = entry();

		await production.start();
		const built = await fetch()?.(new Request("http://localhost/"), {});
		const dev = await development.fetchDev(new Request("http://localhost/"), {}, async (_, next) =>
			next(),
		);

		expect(built?.headers.get("X-Build-Id")).toBe("b42");
		expect(dev.headers.get("X-Build-Id")).toBeNull();
		expect(dev.headers.get("Server-Timing")).toBeNull();
	});

	it("listens on the host's listeners when the app sets none", async () => {
		const { host, fetch } = testHost();
		const entry = createEntry({
			app: createServer({ plugins: [], logger: recordingLogger([]) }),
			host,
			framework: () => stubFramework(),
		});

		await entry.start();
		const response = await fetch()?.(new Request("http://localhost/"), {});

		await expect(response?.text()).resolves.toBe("rendered");
	});

	it("reads the prerendered paths from the build manifest when the framework has none", async () => {
		const lines: string[] = [];
		const { host } = testHost();
		const entry = createEntry({
			app: createServer({ plugins: [prerendered()], logger: recordingLogger(lines) }),
			host,
			clientDirectory,
			framework: () => ({ name: "stub", fetch: renderedFramework }),
		});

		await entry.start();

		expect(lines).toContain(
			`prerendered paths with no file ${JSON.stringify({ "app_server.missing_paths": ["/gone"] })}`,
		);
	});

	it("serves the client build as it was at start", async () => {
		const { host, fetch } = testHost();
		const entry = createEntry({
			app: createServer({ plugins: [prerendered()], logger: recordingLogger([]) }),
			host,
			clientDirectory,
			framework: () => ({ name: "stub", fetch: renderedFramework }),
		});

		await entry.start();
		writeFileSync(join(clientDirectory, "late.txt"), "late");
		const page = await fetch()?.(new Request("http://localhost/cpu"), {});
		const late = await fetch()?.(new Request("http://localhost/late.txt"), {});

		await expect(page?.text()).resolves.toBe("<h1>CPU</h1>");
		await expect(late?.text()).resolves.toBe("rendered");
	});

	it("keeps a small file in memory after the first read, and serves ranges from it", async () => {
		writeFileSync(join(clientDirectory, "kept.txt"), "export const kept = 1;");
		const { host, fetch } = testHost();
		const entry = createEntry({
			app: createServer({ plugins: [prerendered()], logger: recordingLogger([]) }),
			host,
			clientDirectory,
			framework: () => ({ name: "stub", fetch: renderedFramework }),
		});
		await entry.start();
		const request = async (init?: RequestInit) =>
			fetch()?.(new Request("http://localhost/kept.txt", init), {});
		await (await request())?.text();
		writeFileSync(join(clientDirectory, "kept.txt"), "export const kept = 2;");

		const full = await request();
		const range = await request({ headers: { Range: "bytes=7-11" } });

		await expect(full?.text()).resolves.toBe("export const kept = 1;");
		expect(range?.status).toBe(206);
		await expect(range?.text()).resolves.toBe("const");
	});

	it("reads a file over 256 KiB from disk on each request", async () => {
		const size = 256 * 1024 + 1;
		writeFileSync(join(clientDirectory, "large.txt"), "a".repeat(size));
		const { host, fetch } = testHost();
		const entry = createEntry({
			app: createServer({ plugins: [prerendered()], logger: recordingLogger([]) }),
			host,
			clientDirectory,
			framework: () => ({ name: "stub", fetch: renderedFramework }),
		});
		await entry.start();
		const request = async () => fetch()?.(new Request("http://localhost/large.txt"), {});
		await (await request())?.text();
		writeFileSync(join(clientDirectory, "large.txt"), "b".repeat(size));

		const response = await request();

		await expect(response?.text()).resolves.toBe("b".repeat(size));
	});

	it("gives the request ID and logger to requestContext() during a request", async () => {
		const { host, fetch } = testHost();
		const seen = vi.fn<(id: string | undefined) => void>();
		const entry = createEntry({
			app: createServer({ plugins: [requestId()], logger: recordingLogger([]) }),
			host,
			framework: () =>
				stubFramework(async () => {
					seen(requestContext()?.requestId);
					return new Response("ok");
				}),
		});

		await entry.start();
		await fetch()?.(
			new Request("http://localhost/", { headers: { "X-Request-Id": "abc-123" } }),
			{},
		);

		expect(seen).toHaveBeenCalledWith("abc-123");
		expect(requestContext()).toBeUndefined();
	});

	it("keeps requestContext() for an entry when another entry has a host with no storage", async () => {
		const { host, fetch } = testHost();
		const seen = vi.fn<(id: string | undefined) => void>();
		const entry = createEntry({
			app: createServer({ plugins: [requestId()], logger: recordingLogger([]) }),
			host,
			framework: () =>
				stubFramework(async () => {
					seen(requestContext()?.requestId);
					return new Response("ok");
				}),
		});
		createEntry({
			app: createServer({ logger: recordingLogger([]) }),
			host: { name: host.name, files: host.files },
			framework: () => stubFramework(),
		});

		await entry.start();
		await fetch()?.(
			new Request("http://localhost/", { headers: { "X-Request-Id": "abc-123" } }),
			{},
		);

		expect(seen).toHaveBeenCalledWith("abc-123");
	});

	it("answers production requests through fetch with no listener, and sets up once", async () => {
		const setup = vi.fn<() => void>();
		const entry = createEntry({
			app: createServer({ plugins: [buildId(), prerendered(), { name: "count", setup }] }),
			host: { name: "serverless", files: nodeHost.files },
			clientDirectory,
			framework: () => ({ name: "stub", fetch: renderedFramework }),
		});

		const [page, rendered] = await Promise.all([
			entry.fetch(new Request("http://localhost/cpu"), {}),
			entry.fetch(new Request("http://localhost/about"), {}),
		]);

		await expect(page.text()).resolves.toBe("<h1>CPU</h1>");
		await expect(rendered.text()).resolves.toBe("rendered");
		expect(rendered.headers.get("X-Build-Id")).toBe("b42");
		expect(setup).toHaveBeenCalledTimes(1);
	});

	it("runs each setup again on the next request after a setup fails", async () => {
		const setup = vi.fn<() => void>().mockImplementationOnce(() => {
			throw new Error("config server down");
		});
		const entry = createEntry({
			app: createServer({ plugins: [{ name: "remote-config", setup }] }),
			host: { name: "serverless", files: nodeHost.files },
			clientDirectory,
			framework: () => ({ name: "stub", fetch: renderedFramework }),
		});

		await expect(entry.fetch(new Request("http://localhost/about"), {})).rejects.toThrow(
			"config server down",
		);
		const response = await entry.fetch(new Request("http://localhost/about"), {});

		await expect(response.text()).resolves.toBe("rendered");
		expect(setup).toHaveBeenCalledTimes(2);
	});

	it("refuses to start when neither the app nor the host has a listener", async () => {
		const entry = createEntry({
			app: createServer({ plugins: [], logger: recordingLogger([]) }),
			host: { name: "serverless", files: nodeHost.files },
			clientDirectory,
			framework: () => stubFramework(),
		});

		await expect(entry.start()).rejects.toThrow("has no listener");
	});

	it("names the adapter when no client directory is known", async () => {
		const { host } = testHost();
		const entry = createEntry({
			app: createServer({ plugins: [], logger: recordingLogger([]) }),
			host,
			framework: () => ({ name: "custom", fetch: renderedFramework }),
		});

		await expect(entry.start()).rejects.toThrow(
			"the custom adapter does not know the client build",
		);
	});
});
