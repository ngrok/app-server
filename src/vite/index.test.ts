import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preview } from "vite";
import type { Plugin } from "vite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { reactRouterAdapter } from "../react-router/vite.js";
import { node } from "../node/vite.js";
import { appServer, serverEntrySource } from "./index.js";

const root = mkdtempSync(join(tmpdir(), "app-server-vite-"));
mkdirSync(join(root, "build/client"), { recursive: true });

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Answers like a framework's preview handler: one `writeHead` with every header. */
function responder(): Plugin {
	return {
		name: "responder",
		configurePreviewServer: (server) => () => {
			server.middlewares.use((request, response) => {
				const status = request.url === "/missing" ? 404 : 200;
				const headers = {
					"content-type":
						request.url === "/page" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
					"access-control-allow-origin": "*",
					"set-cookie": "session=1",
					"content-length": "2",
				};
				if (request.url === "/llms.txt") {
					// Why: TanStack Start's preview server sets the headers, then sends them again as a
					// flat array.
					response.setHeaders(new Map(Object.entries(headers)));
					response.writeHead(status, "", Object.entries(headers).flat());
				} else {
					response.writeHead(status, "", headers);
				}
				response.end("ok");
			});
		},
	};
}

describe("appServer", () => {
	it("records each 2xx path, and the headers of each that is not a document, with no cookie or length", async () => {
		vi.stubEnv("IS_RR_BUILD_REQUEST", "yes");
		const server = await preview({
			root,
			configFile: false,
			appType: "custom",
			logLevel: "silent",
			plugins: [appServer({ framework: reactRouterAdapter(), host: node() }), responder()],
			build: { outDir: "build/client" },
			preview: { port: 0, host: "127.0.0.1" },
		});
		const base = server.resolvedUrls?.local[0] ?? "";

		await (await fetch(new URL("/llms.txt", base))).text();
		await (await fetch(new URL("/components/button/", base))).text();
		await (await fetch(new URL("/missing", base))).text();
		await (await fetch(new URL("/page", base))).text();
		await server.close();

		expect(
			JSON.parse(readFileSync(join(root, "build/client/.app-server.json"), "utf8")),
		).toStrictEqual({
			prerendered: ["/components/button", "/llms.txt", "/page"],
			headers: {
				"/components/button": {
					"access-control-allow-origin": "*",
					"content-type": "text/plain; charset=utf-8",
				},
				"/llms.txt": {
					"access-control-allow-origin": "*",
					"content-type": "text/plain; charset=utf-8",
				},
			},
		});
	});

	it("records nothing outside the framework's prerender pass", async () => {
		const outside = mkdtempSync(join(tmpdir(), "app-server-vite-outside-"));
		const server = await preview({
			root: outside,
			configFile: false,
			appType: "custom",
			logLevel: "silent",
			plugins: [appServer({ framework: reactRouterAdapter(), host: node() }), responder()],
			build: { outDir: "build/client" },
			preview: { port: 0, host: "127.0.0.1" },
		});

		await (await fetch(new URL("/llms.txt", server.resolvedUrls?.local[0]))).text();
		await server.close();

		expect(existsSync(join(outside, "build/client/.app-server.json"))).toBe(false);
		rmSync(outside, { recursive: true, force: true });
	});

	it("generates an entry that the bundle's copy of the package makes from the adapters", () => {
		expect(
			serverEntrySource({
				framework: reactRouterAdapter(),
				host: node(),
				appModule: "/app/server.ts",
				clientDirectory: "CLIENT",
			}),
		).toBe(
			[
				'import * as serverModule from "virtual:react-router/server-build";',
				'import { createEntry, createServer } from "@ngrok/app-server";',
				'import { runtime } from "@ngrok/app-server/react-router";',
				'import { host } from "@ngrok/app-server/node";',
				'import app from "/app/server.ts";',
				"export const appServer = createEntry({",
				"\tapp,",
				"\thost,",
				"\tclientDirectory: CLIENT,",
				"\tframework: (mode) => runtime(serverModule, { mode }),",
				"});",
			].join("\n"),
		);
	});

	it("fails the build for a base other than /", async () => {
		await expect(
			preview({
				root,
				configFile: false,
				base: "/docs/",
				logLevel: "silent",
				plugins: [appServer({ framework: reactRouterAdapter(), host: node() })],
				preview: { port: 0, host: "127.0.0.1" },
			}),
		).rejects.toThrow('serves a build at "/" only, and this config has the base "/docs/"');
	});
});
