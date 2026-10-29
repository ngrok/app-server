import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { host as nodeHost } from "../node/index.js";
import { renderedFramework, stubFramework } from "../test-server.js";
import type { AppServer } from "./create-server.js";
import { createServer } from "./create-server.js";
import { createEntry } from "./entry.js";
import { prerendered } from "./plugins/static.js";
import { requestId } from "./plugins/request-id.js";
import { requestContext } from "./request-context.js";
import type { FetchHandler, HostRuntime, Listener, LogSink } from "./types.js";

const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-entry-"));
writeFileSync(
	join(clientDirectory, ".app-server.json"),
	JSON.stringify({ prerendered: ["/cpu", "/gone"], headers: {} }),
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
