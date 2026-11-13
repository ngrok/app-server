import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { accessLog, createEntry, createServer } from "../core/index.js";
import type { LogLine } from "../core/index.js";
import { host, requestListener } from "./index.js";

describe("the exports of @ngrok/app-server/node", () => {
	// Why the whole list: the server entry that `appServer` generates exports this module, so
	// each node-host server build holds the code of each export.
	it("have only what a production server uses", async () => {
		expect(Object.keys(await import("./index.js")).toSorted()).toStrictEqual([
			"host",
			"nodeFiles",
			"parsePort",
			"requestListener",
			"tcp",
		]);
	});
});

describe("requestListener", () => {
	it("serves an entry on a `node:http` server of the app, and reports the head that went out", async () => {
		const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-node-"));
		const requestLine = Promise.withResolvers<LogLine>();
		const entry = createEntry({
			app: createServer({
				plugins: [
					accessLog({
						attributes: ({ sent }) => ({
							"sent.content_length": sent.headers.get("Content-Length"),
						}),
					}),
				],
				logger: {
					log: (line) => {
						if (line.message === "request") {
							requestLine.resolve(line);
						}
					},
				},
			}),
			host: { files: host.files },
			clientDirectory,
			framework: () => ({ name: "stub", fetch: async () => new Response("rendered") }),
		});
		const listener = requestListener(entry.fetch);
		const server = createHttpServer((incoming, outgoing) => {
			void listener(incoming, outgoing);
		});
		onTestFinished(async () => {
			await new Promise((resolve) => {
				server.close(resolve);
			});
			rmSync(clientDirectory, { recursive: true, force: true });
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const { port } = server.address() as AddressInfo;

		const response = await fetch(`http://127.0.0.1:${port}/`, {
			headers: { Connection: "close" },
		});

		await expect(response.text()).resolves.toBe("rendered");
		// Why `Content-Length`: the response of the framework has none. The listener adds it, and
		// only its `edge` binding gives the access log the head that the listener wrote.
		await expect(requestLine.promise).resolves.toMatchObject({
			attributes: { "sent.content_length": "8", "network.bytes_written": 8 },
		});
	});
});
