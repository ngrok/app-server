import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { host as nodeHost } from "../node/index.js";
import { renderedFramework, stubFramework } from "../test-server.js";
import type { AppServer } from "./create-server.js";
import { createServer } from "./create-server.js";
import { createEntry } from "./entry.js";
import { flushLogs } from "./log.js";
import { accessLog } from "./plugins/access-log.js";
import { buildId } from "./plugins/build-id.js";
import { assets, prerendered } from "./plugins/static.js";
import { requestId } from "./plugins/request-id.js";
import { requestContext } from "./request-context.js";
import type { FetchHandler, HostRuntime, Listener, LogLine, LogSink, Plugin, StaticFiles } from "./types.js";

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
		start: async (fetch) => {
			handler = fetch;
			return { url: "http://localhost:1/", stop: async () => {} };
		},
	};
	return {
		host: { ...nodeHost, listeners: [listener], lifecycle: { onStop: () => {} } },
		fetch: () => handler,
	};
}

function recordingLogger(lines: string[]): LogSink {
	return {
		log: ({ message, attributes }) => {
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
			app: createServer({ plugins: [assets()] }),
			host: nodeHost,
			framework: () => stubFramework(),
		});

		const response = await entry.fetchDev(new Request("http://localhost/"), {}, async (_, next) =>
			next(),
		);

		await expect(response.text()).resolves.toBe("rendered");
	});

	it("writes the lines of the default sink as text in development, and as JSON in production", async () => {
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const written = () => write.mock.calls.map(([line]) => String(line));
		const entry = () =>
			createEntry({
				app: createServer({ plugins: [accessLog(), assets()] }),
				host: testHost().host,
				clientDirectory,
				framework: () => stubFramework(),
			});

		const page = await entry().fetchDev(new Request("http://localhost/"), {}, async (_, next) =>
			next(),
		);
		await page.text();

		expect(written()).toStrictEqual([
			expect.stringMatching(/^time=\S+ level=INFO msg=request .*http\.status_code=200/u),
		]);

		write.mockClear();
		const built = await entry().fetch(new Request("http://localhost/about"), {});
		await built.text();
		flushLogs();

		expect(written().map((line): unknown => JSON.parse(line))).toStrictEqual([
			expect.objectContaining({ level: "info", message: "request", "http.status_code": 200 }),
		]);
	});

	it("gives each development line to the app's own sink", async () => {
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const lines: string[] = [];
		const entry = createEntry({
			app: createServer({ plugins: [accessLog(), assets()], logger: recordingLogger(lines) }),
			host: nodeHost,
			framework: () => stubFramework(),
		});

		const page = await entry.fetchDev(new Request("http://localhost/"), {}, async (_, next) =>
			next(),
		);
		await page.text();

		expect(lines).toStrictEqual([expect.stringMatching(/^request /u)]);
		expect(write).not.toHaveBeenCalled();
	});

	it("stops a development request when no plugin runs the dev server", async () => {
		const entry = createEntry({
			app: createServer({ plugins: [requestId()], logger: recordingLogger([]) }),
			host: testHost().host,
			clientDirectory,
			framework: () => stubFramework(),
		});
		const devServer = async () => new Response("export {};");

		await expect(
			entry.fetchDev(new Request("http://localhost/@vite/client"), {}, devServer),
		).rejects.toThrow(
			"No plugin runs the dev server, so Vite serves no source module, HMR client, or CSS. Add assets() to the plugin list.",
		);
		const built = await entry.fetch(new Request("http://localhost/about"), {});
		await expect(built.text()).resolves.toBe("rendered");
	});

	it("answers from the dev server through assets(), and through a plugin of the app that takes it", async () => {
		let stage: Plugin["middleware"];
		const mounted: Plugin = {
			name: "own-dev-server",
			setup: (info) => {
				if (info.mode === "development") {
					stage = info.devServer;
				}
			},
			middleware: async (context, next) => stage?.(context, next) ?? next(),
		};
		const devServer = async () => new Response("export {};");

		for (const plugins of [[assets()], [mounted]]) {
			const entry = createEntry({
				app: createServer({ plugins, logger: recordingLogger([]) }),
				host: nodeHost,
				framework: () => stubFramework(),
			});
			const response = await entry.fetchDev(
				new Request("http://localhost/@vite/client"),
				{},
				devServer,
			);

			await expect(response.text()).resolves.toBe("export {};");
		}
	});

	it("in development, gives a twin when the framework does not know the prerendered paths", async () => {
		const framework = stubFramework(async (request) =>
			request.url.endsWith(".md")
				? new Response("# Twin", { headers: { "Content-Type": "text/markdown" } })
				: new Response("rendered"),
		);
		const entry = createEntry({
			app: createServer({ plugins: [assets(), prerendered({ markdownTwins: true })] }),
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

	it("asks the host for the files one time for the development requests of an entry", async () => {
		const files = vi.fn<HostRuntime["files"]>(nodeHost.files);
		const entry = createEntry({
			app: createServer({ plugins: [assets()] }),
			host: { ...nodeHost, files },
			framework: () => stubFramework(),
		});

		for (const path of ["/", "/about", "/docs"]) {
			const response = await entry.fetchDev(
				new Request(`http://localhost${path}`),
				{},
				async (_, next) => next(),
			);
			await response.text();
		}

		expect(files).toHaveBeenCalledTimes(1);
	});

	it("runs each setup again on the next development request after a setup fails", async () => {
		const setup = vi.fn<() => void>().mockImplementationOnce(() => {
			throw new Error("config server down");
		});
		const entry = createEntry({
			app: createServer({ plugins: [assets(), { name: "remote-config", setup }] }),
			host: nodeHost,
			framework: () => stubFramework(),
		});
		const request = async () =>
			entry.fetchDev(new Request("http://localhost/"), {}, async (_, next) => next());

		await expect(request()).rejects.toThrow("config server down");
		const response = await request();

		await expect(response.text()).resolves.toBe("rendered");
		expect(setup).toHaveBeenCalledTimes(2);
	});

	it("sends the build ID of the build manifest in production, and none in development", async () => {
		const { host, fetch } = testHost();
		const entry = (): ReturnType<typeof createEntry> =>
			createEntry({
				app: createServer({ plugins: [buildId(), assets()], logger: recordingLogger([]) }),
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

	it("reads the build manifest with no range, as a file that it does not keep in memory", async () => {
		const opened: unknown[] = [];
		const recording = (files: StaticFiles): StaticFiles => {
			const { snapshot } = files;
			return {
				stat: files.stat,
				open: async (path, range) => {
					opened.push([path, range]);
					return files.open(path, range);
				},
				...(snapshot == null ? {} : { snapshot: async () => recording(await snapshot()) }),
			};
		};
		const { host } = testHost();
		const entry = createEntry({
			app: createServer({ plugins: [], logger: recordingLogger([]) }),
			host: { ...host, files: (directory) => recording(host.files(directory)) },
			clientDirectory,
			framework: () => ({ name: "stub", fetch: renderedFramework }),
		});

		await entry.start();

		expect(opened).toStrictEqual([["/.app-server.json", undefined]]);
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
			host: { files: host.files },
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
			host: { files: nodeHost.files },
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
		const lines: string[] = [];
		const entry = createEntry({
			app: createServer({
				plugins: [{ name: "remote-config", setup }],
				logger: recordingLogger(lines),
			}),
			host: { files: nodeHost.files },
			clientDirectory,
			framework: () => ({ name: "stub", fetch: renderedFramework }),
		});

		await expect(entry.fetch(new Request("http://localhost/about"), {})).rejects.toThrow(
			"config server down",
		);
		const response = await entry.fetch(new Request("http://localhost/about"), {});
		const later = await entry.fetch(new Request("http://localhost/about"), {});

		await expect(response.text()).resolves.toBe("rendered");
		await expect(later.text()).resolves.toBe("rendered");
		expect(setup).toHaveBeenCalledTimes(2);
		expect(lines).toStrictEqual([expect.stringMatching(/^setup failed .*config server down/u)]);
	});

	it("gives the setup of a plugin a logger with one method for each level", async () => {
		const lines: LogLine[] = [];
		const entry = createEntry({
			app: createServer({
				plugins: [
					{
						name: "cache",
						setup: (info) => {
							info.logger.warn("cache is cold", { "cache.entries": 0 });
						},
					},
				],
				logger: {
					log: (line) => {
						lines.push(line);
					},
				},
			}),
			host: { files: nodeHost.files },
			clientDirectory,
			framework: () => ({ name: "stub", fetch: renderedFramework }),
		});

		await entry.fetch(new Request("http://localhost/about"), {});

		expect(lines).toStrictEqual([
			{ level: "warn", message: "cache is cold", attributes: { "cache.entries": 0 } },
		]);
	});

	it("warns one time when the client build is not there, and names the directory", async () => {
		const lines: LogLine[] = [];
		const missing = join(clientDirectory, "no-such-build/client");
		const entry = createEntry({
			app: createServer({
				plugins: [],
				logger: {
					log: (line) => {
						lines.push(line);
					},
				},
			}),
			host: { files: nodeHost.files },
			clientDirectory: missing,
			framework: () => ({ name: "stub", fetch: renderedFramework }),
		});

		await entry.fetch(new Request("http://localhost/assets/app.js"), {});
		await entry.fetch(new Request("http://localhost/assets/app.js"), {});

		expect(lines).toStrictEqual([
			{
				level: "warn",
				message: "client build not found",
				attributes: { "app_server.client_directory": missing },
			},
		]);
	});

	it("writes no warning for a client build with no files", async () => {
		const lines: LogLine[] = [];
		const empty = join(clientDirectory, "empty");
		mkdirSync(empty);
		const entry = createEntry({
			app: createServer({
				plugins: [],
				logger: {
					log: (line) => {
						lines.push(line);
					},
				},
			}),
			host: { files: nodeHost.files },
			clientDirectory: empty,
			framework: () => ({ name: "stub", fetch: renderedFramework }),
		});

		await entry.fetch(new Request("http://localhost/"), {});

		expect(lines).toStrictEqual([]);
	});

	it("refuses to start when neither the app nor the host has a listener", async () => {
		const entry = createEntry({
			app: createServer({ plugins: [], logger: recordingLogger([]) }),
			host: { files: nodeHost.files },
			clientDirectory,
			framework: () => stubFramework(),
		});

		await expect(entry.start()).rejects.toThrow("has no listener");
	});

	it("logs one error line when a setup stops the start", async () => {
		const lines: string[] = [];
		const entry = createEntry({
			app: createServer({
				plugins: [
					{
						name: "remote-config",
						setup: () => {
							throw new Error("config server down");
						},
					},
				],
				logger: recordingLogger(lines),
			}),
			host: testHost().host,
			clientDirectory,
			framework: () => stubFramework(),
		});

		await expect(entry.start()).rejects.toThrow("config server down");
		expect(lines).toStrictEqual([expect.stringMatching(/^startup failed .*config server down/u)]);
	});

	it("logs one error line when a listener stops the start", async () => {
		const lines: string[] = [];
		const entry = createEntry({
			app: createServer({ plugins: [], logger: recordingLogger(lines) }),
			host: {
				...nodeHost,
				listeners: () => [
					{
						name: "taken",
						start: async () => {
							throw new Error("address in use");
						},
					},
				],
				lifecycle: { onStop: () => {} },
			},
			clientDirectory,
			framework: () => stubFramework(),
		});

		await expect(entry.start()).rejects.toThrow("address in use");
		expect(lines).toStrictEqual([expect.stringMatching(/^startup failed .*address in use/u)]);
	});

	it("names the build manifest when the file is not whole JSON", async () => {
		const cut = mkdtempSync(join(tmpdir(), "app-server-entry-cut-"));
		onTestFinished(() => {
			rmSync(cut, { recursive: true, force: true });
		});
		writeFileSync(join(cut, ".app-server.json"), '{"buildId":"b42","prerendered":["/cp');
		const entry = createEntry({
			app: createServer({ plugins: [], logger: recordingLogger([]) }),
			host: testHost().host,
			clientDirectory: cut,
			framework: () => stubFramework(),
		});

		await expect(entry.start()).rejects.toThrow(
			"The server cannot read .app-server.json as JSON. Build the app again.",
		);
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
