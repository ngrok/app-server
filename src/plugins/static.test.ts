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
import { assets, prerendered } from "./static.js";
import type { PrerenderedOptions } from "./static.js";

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

async function staticServer(options: PrerenderedOptions = {}, prerenderedPaths: string[] = []) {
	return testServer({
		plugins: [assets(), prerendered(options)],
		clientDirectory,
		prerenderedPaths,
	});
}

describe("prerendered", () => {
	it("serves a prerendered page at its own URL with a 200 and no redirect", async () => {
		const { request } = await staticServer();

		const response = await request("/components/button");

		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("<h1>Button</h1>");
		expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
	});

	it("serves the root page from index.html", async () => {
		const { request } = await staticServer();

		await expect((await request("/")).text()).resolves.toBe("<h1>Home</h1>");
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

	it("serves the file that rewrite names, with that file's headers", async () => {
		const { request } = await staticServer({
			rewrite: (path, context) =>
				context.req.header("Accept") === "text/markdown" ? `${path}.md` : path,
		});

		const markdown = await request("/components/button", { headers: { Accept: "text/markdown" } });
		const page = await request("/components/button");

		await expect(markdown.text()).resolves.toBe("# Button");
		expect(markdown.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
		await expect(page.text()).resolves.toBe("<h1>Button</h1>");
	});

	it("puts the etagPart of each earlier plugin in the ETag", async () => {
		const withPart = async (part: string) =>
			testServer({
				plugins: [{ name: "versioned", etagPart: () => part }, prerendered()],
				clientDirectory,
			});
		const etag = async (part: string) =>
			(await (await withPart(part)).request("/llms.txt")).headers.get("ETag");

		await expect(etag("v1")).resolves.toBe(await etag("v1"));
		await expect(etag("v1")).resolves.not.toBe(await etag("v2"));
	});

	it("applies the request-path rules to a rewritten path", async () => {
		const rewrites: Record<string, string> = {
			"/secret": "/.env",
			"/alias": "/components//button",
			"/escape": "/../outside.txt",
		};
		const { request } = await staticServer({ rewrite: (path) => rewrites[path] ?? path });

		for (const path of Object.keys(rewrites)) {
			await expect((await request(path)).text()).resolves.toBe("rendered");
		}
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

		expect(etag).toMatch(/^W\/"[\da-f]+-[\da-f]+"$/u);
		expect(response.status).toBe(304);
		await expect(response.text()).resolves.toBe("");
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
		await expect(response.text()).resolves.toBe("");
	});

	it("never serves a dotfile or the captured headers, but serves /.well-known/", async () => {
		const { request } = await staticServer();

		await expect((await request("/.env")).text()).resolves.toBe("rendered");
		await expect((await request("/%2eenv")).text()).resolves.toBe("rendered");
		await expect((await request("/%E0%A4%A")).text()).resolves.toBe("rendered");
		await expect((await request("/.headers.json")).text()).resolves.toBe("rendered");
		await expect((await request("/.well-known/security.txt")).text()).resolves.toBe(
			"Contact: security@example.com",
		);
	});

	it("hands each other name for a file to the framework, so a file has one URL and its headers", async () => {
		const { request } = await staticServer();

		await expect((await request("/components%2Fbutton")).text()).resolves.toBe("rendered");
		await expect((await request("/components//button")).text()).resolves.toBe("rendered");
		await expect((await request("/components/button/index.html")).text()).resolves.toBe("rendered");
	});

	it("never serves a file outside the client build", async () => {
		const { request } = await staticServer();

		const response = await request("/assets/..%2f..%2f..%2fetc%2fpasswd");

		expect(response.status).toBe(404);
	});

	it("hands a path with no file and a POST to the framework", async () => {
		const { request } = await staticServer();

		await expect((await request("/components/missing")).text()).resolves.toBe("rendered");
		await expect((await request("/llms.txt", { method: "POST" })).text()).resolves.toBe("rendered");
	});

	it("warns at startup about each prerendered path that has no file", async () => {
		const { lines } = await staticServer({}, ["/components/button", "/llms.txt", "/gone"]);

		expect(lines).toStrictEqual([
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
		await expect(response.text()).resolves.toBe("export {};");
	});

	it("answers a missing asset with a plain 404, not a rendered page", async () => {
		const { request } = await staticServer();

		const response = await request("/assets/entry-old.js");

		expect(response.status).toBe(404);
		await expect(response.text()).resolves.toBe("Not Found");
	});
});

describe("assets in development", () => {
	it("sends the request ID with Vite's answer and logs Vite's status and length", async () => {
		const lines: LoggedLine[] = [];
		const app = createServer({
			plugins: [requestId(), accessLog(), assets()],
			logger: {
				log: (level, message, attributes) => {
					lines.push({ level, message, attributes });
				},
			},
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
		await expect(response.text()).resolves.toBe("teapot");
		expect(response.headers.get("X-Request-Id")).toBe("abc-123");
		expect(lines.find((line) => line.message === "request")?.attributes).toMatchObject({
			"http.status_code": 418,
			"network.bytes_written": 6,
		});
	});
});
