import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preview, type Plugin } from "vite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { serverEntry, serverEntrySource } from "./vite.js";

const root = mkdtempSync(join(tmpdir(), "app-server-vite-"));
mkdirSync(join(root, "build/client"), { recursive: true });

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Answers like React Router's preview handler: one `writeHead` with every header. */
const responder = (): Plugin => ({
	name: "responder",
	configurePreviewServer: (server) => () => {
		server.middlewares.use((request, response) => {
			const status = request.url === "/missing" ? 404 : 200;
			response.writeHead(status, "", {
				"content-type":
					request.url === "/page" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
				"access-control-allow-origin": "*",
				"set-cookie": "session=1",
				"content-length": "2",
			});
			response.end("ok");
		});
	},
});

describe("serverEntry", () => {
	it("records the headers of each 2xx file that is not a document, with no cookie or length", async () => {
		vi.stubEnv("IS_RR_BUILD_REQUEST", "yes");
		const server = await preview({
			root,
			configFile: false,
			appType: "custom",
			logLevel: "silent",
			plugins: [serverEntry(), responder()],
			build: { outDir: "build/client" },
			preview: { port: 0, host: "127.0.0.1" },
		});
		const base = server.resolvedUrls?.local[0] ?? "";

		await (await fetch(new URL("/llms.txt", base))).text();
		await (await fetch(new URL("/components/button/", base))).text();
		await (await fetch(new URL("/missing", base))).text();
		await (await fetch(new URL("/page", base))).text();
		await server.close();

		expect(JSON.parse(readFileSync(join(root, "build/client/.headers.json"), "utf8"))).toEqual({
			"/components/button": {
				"access-control-allow-origin": "*",
				"content-type": "text/plain; charset=utf-8",
			},
			"/llms.txt": {
				"access-control-allow-origin": "*",
				"content-type": "text/plain; charset=utf-8",
			},
		});
	});

	it("exports the entry that the CLI calls, made by the bundle's copy of the package", () => {
		expect(serverEntrySource("/app/server.ts")).toBe(
			[
				'export * from "virtual:react-router/server-build";',
				'import * as build from "virtual:react-router/server-build";',
				'import { appServerEntry } from "@ngrok/app-server/react-router";',
				'import app from "/app/server.ts";',
				"export const appServer = appServerEntry(build, app);",
			].join("\n"),
		);
		expect(serverEntrySource(undefined)).toContain(
			"export const appServer = appServerEntry(build);",
		);
	});
});
