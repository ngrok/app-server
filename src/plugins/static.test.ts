import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createServer, serverInternals } from "../create-server.js";
import type { LoggedLine } from "../test-server.js";
import { testServer } from "../test-server.js";
import { tcp } from "../tcp.js";
import type { NodeMiddleware } from "../types.js";
import { accessLog } from "./access-log.js";
import { requestId } from "./request-id.js";
import { assets, prerendered, type PrerenderedOptions } from "./static.js";

const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-static-"));
const files: Record<string, string> = {
	"index.html": "<h1>Home</h1>",
	"components/button/index.html": "<h1>Button</h1>",
	"components/button.md": "# Button",
	"components/button.data": "[data]",
	"llms.txt": "llms",
	"llms-full.txt": "x".repeat(200_000),
	"assets/entry-abc123.js": "export {};",
	".env": "SECRET=1",
	".well-known/security.txt": "Contact: security@example.com",
	".headers.json": JSON.stringify({
		"/llms.txt": {
			"content-type": "text/plain; charset=utf-8",
			"access-control-allow-origin": "*",
		},
		"/components/button": { "content-security-policy": "default-src 'self'" },
	}),
};
for (const [path, content] of Object.entries(files)) {
	mkdirSync(dirname(join(clientDirectory, path)), { recursive: true });
	writeFileSync(join(clientDirectory, path), content);
}

afterAll(() => {
	rmSync(clientDirectory, { recursive: true, force: true });
});

const staticServer = (options: PrerenderedOptions = {}, prerenderedPaths: string[] = []) =>
	testServer({ plugins: [assets(), prerendered(options)], clientDirectory, prerenderedPaths });

describe("prerendered", () => {
	it("serves a prerendered page at its own URL with a 200 and no redirect", async () => {
		const { request } = await staticServer();

		const response = await request("/components/button");

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("<h1>Button</h1>");
		expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
	});

	it("serves the root page from index.html", async () => {
		const { request } = await staticServer();

		expect(await (await request("/")).text()).toBe("<h1>Home</h1>");
	});

	it("replays the headers captured at build time, keyed with no trailing slash", async () => {
		const { request } = await staticServer();

		const page = await request("/components/button/");
		const agentFile = await request("/llms.txt");

		expect(page.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
		expect(agentFile.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(agentFile.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
	});

	it("lets the headers option replace a captured header", async () => {
		const { request } = await staticServer({
			headers: (path) =>
				path === "/llms.txt" ? { "Access-Control-Allow-Origin": "https://a.example" } : undefined,
		});

		const response = await request("/llms.txt");

		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://a.example");
	});

	it("serves a page's markdown file to a client that prefers markdown", async () => {
		const { request } = await staticServer({ markdownTwins: true });

		const response = await request("/components/button/", {
			headers: { Accept: "text/markdown, text/html;q=0.9" },
		});

		expect(await response.text()).toBe("# Button");
		expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
		expect(response.headers.get("Vary")).toBe("Accept");
	});

	it("serves HTML, with Vary, to a client that refuses markdown or does not name it", async () => {
		const { request } = await staticServer({ markdownTwins: true });

		const refuses = await request("/components/button", {
			headers: { Accept: "text/html, text/markdown;q=0" },
		});
		const browser = await request("/components/button", {
			headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
		});

		expect(await refuses.text()).toBe("<h1>Button</h1>");
		expect(await browser.text()).toBe("<h1>Button</h1>");
		expect(browser.headers.get("Vary")).toBe("Accept");
	});

	it("sends Vary: Accept only for a page with a markdown file", async () => {
		const { request } = await staticServer({ markdownTwins: true });

		const response = await request("/llms.txt", { headers: { Accept: "text/markdown" } });

		expect(await response.text()).toBe("llms");
		expect(response.headers.get("Vary")).toBeNull();
	});

	it("serves the page itself when markdownTwins is off", async () => {
		const { request } = await staticServer();

		const response = await request("/components/button", { headers: { Accept: "text/markdown" } });

		expect(await response.text()).toBe("<h1>Button</h1>");
		expect(response.headers.get("Vary")).toBeNull();
	});

	it("serves a React Router data file as text/x-script", async () => {
		const { request } = await staticServer();

		const response = await request("/components/button.data");

		expect(response.headers.get("Content-Type")).toBe("text/x-script");
	});

	it("compares If-None-Match with an ETag that the headers option sets", async () => {
		const generatedEtag =
			(await (await staticServer()).request("/llms.txt")).headers.get("ETag") ?? "";
		const { request } = await staticServer({ headers: () => ({ ETag: '"custom"' }) });

		const custom = await request("/llms.txt", { headers: { "If-None-Match": '"custom"' } });
		const generated = await request("/llms.txt", { headers: { "If-None-Match": generatedEtag } });

		expect(custom.status).toBe(304);
		expect(generated.status).toBe(200);
	});

	it("answers 304 to a matching If-None-Match", async () => {
		const { request } = await staticServer();
		const etag = (await request("/llms.txt")).headers.get("ETag") ?? "";

		const response = await request("/llms.txt", { headers: { "If-None-Match": etag } });

		expect(etag).toMatch(/^W\/"[\da-f]+-[\da-f]+"$/);
		expect(response.status).toBe(304);
		expect(await response.text()).toBe("");
	});

	it("streams a large file in chunks, not as one buffer", async () => {
		const { request } = await staticServer();

		const response = await request("/llms-full.txt");
		const reader = response.body?.getReader();
		const first = await reader?.read();
		await reader?.cancel();

		expect(response.headers.get("Content-Length")).toBe("200000");
		expect(first?.value?.byteLength).toBeLessThan(200_000);
	});

	it("answers HEAD with the length and no body", async () => {
		const { request } = await staticServer();

		const response = await request("/llms.txt", { method: "HEAD" });

		expect(response.headers.get("Content-Length")).toBe("4");
		expect(await response.text()).toBe("");
	});

	it("never serves a dotfile or the captured headers, but serves /.well-known/", async () => {
		const { request } = await staticServer();

		expect(await (await request("/.env")).text()).toBe("rendered");
		expect(await (await request("/%2eenv")).text()).toBe("rendered");
		expect(await (await request("/%E0%A4%A")).text()).toBe("rendered");
		expect(await (await request("/.headers.json")).text()).toBe("rendered");
		expect(await (await request("/.well-known/security.txt")).text()).toBe(
			"Contact: security@example.com",
		);
	});

	it("hands each other name for a file to the framework, so a file has one URL and its headers", async () => {
		const { request } = await staticServer();

		expect(await (await request("/components%2Fbutton")).text()).toBe("rendered");
		expect(await (await request("/components//button")).text()).toBe("rendered");
		expect(await (await request("/components/button/index.html")).text()).toBe("rendered");
	});

	it("never serves a file outside the client build", async () => {
		const { request } = await staticServer();

		const response = await request("/assets/..%2f..%2f..%2fetc%2fpasswd");

		expect(response.status).toBe(404);
	});

	it("hands a path with no file and a POST to the framework", async () => {
		const { request } = await staticServer();

		expect(await (await request("/components/missing")).text()).toBe("rendered");
		expect(await (await request("/llms.txt", { method: "POST" })).text()).toBe("rendered");
	});

	it("warns at startup about each prerendered path that has no file", async () => {
		const { lines } = await staticServer({}, ["/components/button", "/llms.txt", "/gone"]);

		expect(lines).toEqual([
			{
				level: "warn",
				message: "prerendered paths with no file",
				attributes: { "app_server.missing_paths": ["/gone"] },
			},
		]);
	});
});

describe("assets", () => {
	it("serves a hashed asset with an immutable one-year cache", async () => {
		const { request } = await staticServer();

		const response = await request("/assets/entry-abc123.js");

		expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		expect(await response.text()).toBe("export {};");
	});

	it("answers a missing asset with a plain 404, not a rendered page", async () => {
		const { request } = await staticServer();

		const response = await request("/assets/entry-old.js");

		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Not Found");
	});
});

describe("assets in development", () => {
	it("sends the request ID with Vite's answer and logs Vite's status and length", async () => {
		const lines: LoggedLine[] = [];
		const app = createServer({
			plugins: [requestId(), accessLog(), assets()],
			logger: { log: (level, message, attributes) => lines.push({ level, message, attributes }) },
			listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		});
		const viteMiddleware: NodeMiddleware = (_, response) => {
			response.statusCode = 418;
			response.setHeader("Content-Length", "6");
			response.end("teapot");
		};
		const internals = serverInternals(app);
		const framework = { clientDirectory, prerenderedPaths: [], fetch: async () => new Response() };
		await internals?.prepare({
			mode: "development",
			viteMiddleware,
			...framework,
			logger: { log: () => {} },
		});
		const server = await internals?.listen(framework);

		const response = await fetch(new URL("/@vite/client", server?.urls[0]), {
			headers: { "X-Request-Id": "abc-123" },
		});
		await server?.shutdown();

		expect(response.status).toBe(418);
		expect(await response.text()).toBe("teapot");
		expect(response.headers.get("X-Request-Id")).toBe("abc-123");
		expect(lines.find((line) => line.message === "request")?.attributes).toMatchObject({
			"http.status_code": 418,
			"network.bytes_written": 6,
		});
	});
});
