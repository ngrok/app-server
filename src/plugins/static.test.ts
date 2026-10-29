import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testServer } from "../test-server.js";
import { assets, prerendered, type PrerenderedOptions } from "./static.js";

const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-static-"));
const files: Record<string, string> = {
	"index.html": "<h1>Home</h1>",
	"components/button/index.html": "<h1>Button</h1>",
	"components/button.md": "# Button",
	"components/button.data": "[data]",
	"llms.txt": "llms",
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

	it("serves the file that rewrite names", async () => {
		const { request } = await staticServer({
			rewrite: (path, context) =>
				context.req.header("Accept") === "text/markdown" ? `${path}.md` : path,
		});

		const response = await request("/components/button", { headers: { Accept: "text/markdown" } });

		expect(await response.text()).toBe("# Button");
		expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
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
