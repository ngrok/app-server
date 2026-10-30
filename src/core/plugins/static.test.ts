import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testServer } from "../../test-server.js";
import { assets, prerendered } from "./static.js";
import type { PrerenderedOptions } from "./static.js";
import type { Plugin } from "../types.js";

const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-static-"));
const files: Record<string, string> = {
	"index.html": "<h1>Home</h1>",
	"components/button/index.html": "<h1>Button</h1>",
	"components/button.md": "# Button",
	"index.md": "# Home",
	"docs/rendered.md": "# Rendered",
	"components/button.data": "[data]",
	"llms.txt": "llms",
	"digits.bin": "0123456789",
	"images/logo.svg": "<svg></svg>",
	"llms-full.txt": "x".repeat(200_000),
	"assets/entry-abc123.js": "export {};",
	".env": "SECRET=1",
	".well-known/security.txt": "Contact: security@example.com",
	".app-server.json": JSON.stringify({
		prerendered: [],
		headers: {
			"/llms.txt": {
				"content-type": "text/plain; charset=utf-8",
				"access-control-allow-origin": "*",
			},
			"/components/button": { "content-security-policy": "default-src 'self'" },
			"/components/button.md": { "cache-control": "max-age=60" },
		},
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

	it("serves a file with the content type that the framework gives for its extension", async () => {
		const { request } = await testServer({
			plugins: [prerendered()],
			clientDirectory,
			framework: { contentTypes: { ".data": "text/x-script" } },
		});

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
		await expect((await request("/.app-server.json")).text()).resolves.toBe("rendered");
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

describe("prerendered cacheControl", () => {
	it("revalidates pages and data files, caches other files for an hour, and keeps a captured value", async () => {
		const { request } = await testServer({
			plugins: [prerendered()],
			clientDirectory,
			framework: { isDataRequest: (path) => path.endsWith(".data") },
		});
		const cacheControl = async (path: string) => (await request(path)).headers.get("Cache-Control");

		await expect(cacheControl("/components/button")).resolves.toBe(
			"public, max-age=0, must-revalidate",
		);
		await expect(cacheControl("/components/button.data")).resolves.toBe(
			"public, max-age=0, must-revalidate",
		);
		await expect(cacheControl("/images/logo.svg")).resolves.toBe(
			"public, max-age=3600, stale-while-revalidate=86400",
		);
		await expect(cacheControl("/components/button.md")).resolves.toBe("max-age=60");
	});

	it("uses the cacheControl option, and sends none for undefined", async () => {
		const { request } = await staticServer({
			cacheControl: (path) => (path.startsWith("/images/") ? "public, max-age=86400" : undefined),
		});

		expect((await request("/images/logo.svg")).headers.get("Cache-Control")).toBe(
			"public, max-age=86400",
		);
		expect((await request("/llms.txt")).headers.get("Cache-Control")).toBeNull();
	});
});

describe("prerendered ranges", () => {
	const ranged = async (range: string, extra: Record<string, string> = {}) => {
		const { request } = await staticServer();
		const response = await request("/digits.bin", { headers: { Range: range, ...extra } });
		return {
			status: response.status,
			contentRange: response.headers.get("Content-Range"),
			contentLength: response.headers.get("Content-Length"),
			body: await response.text(),
		};
	};

	it("answers one byte range with a 206 and those bytes", async () => {
		await expect(ranged("bytes=0-3")).resolves.toStrictEqual({
			status: 206,
			contentRange: "bytes 0-3/10",
			contentLength: "4",
			body: "0123",
		});
		await expect(ranged("bytes=-3")).resolves.toMatchObject({ status: 206, body: "789" });
		await expect(ranged("bytes=7-")).resolves.toMatchObject({ status: 206, body: "789" });
		await expect(ranged("bytes=8-99")).resolves.toMatchObject({
			contentRange: "bytes 8-9/10",
			body: "89",
		});
	});

	it("answers a range after the end of the file with a 416", async () => {
		await expect(ranged("bytes=999999-")).resolves.toStrictEqual({
			status: 416,
			contentRange: "bytes */10",
			contentLength: null,
			body: "",
		});
	});

	it("sends the full file for several ranges, a bad header, and an If-Range", async () => {
		await expect(ranged("bytes=0-1,4-5")).resolves.toMatchObject({
			status: 200,
			body: "0123456789",
		});
		await expect(ranged("bytes=5-2")).resolves.toMatchObject({ status: 200 });
		await expect(ranged("bytes=0-3", { "If-Range": 'W/"x"' })).resolves.toMatchObject({
			status: 200,
			body: "0123456789",
		});
	});

	it("advertises byte ranges on a file", async () => {
		const { request } = await staticServer();

		expect((await request("/digits.bin")).headers.get("Accept-Ranges")).toBe("bytes");
	});
});

describe("prerendered skip", () => {
	it("lets a plugin before it block a prerendered page and its data file", async () => {
		const auth: Plugin = {
			name: "auth",
			middleware: async (context, next) =>
				context.req.path.startsWith("/components/") ? context.text("Unauthorized", 401) : next(),
		};
		const { request } = await testServer({
			plugins: [auth, assets(), prerendered()],
			clientDirectory,
		});

		expect((await request("/components/button")).status).toBe(401);
		expect((await request("/components/button.data")).status).toBe(401);
		expect((await request("/llms.txt")).status).toBe(200);
	});

	it("sends a path that skip matches to the framework, with no file lookup", async () => {
		const { request } = await staticServer({
			skip: (path) => path.startsWith("/components/button"),
		});

		await expect((await request("/components/button")).text()).resolves.toBe("rendered");
		await expect((await request("/components/button.data")).text()).resolves.toBe("rendered");
		await expect((await request("/llms.txt")).text()).resolves.toBe("llms");
	});
});

describe("assets", () => {
	it("serves a hashed asset with an immutable one-year cache", async () => {
		const { request } = await staticServer();

		const response = await request("/assets/entry-abc123.js");

		expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		await expect(response.text()).resolves.toBe("export {};");
	});

	it("answers a missing asset with a plain 404 that no cache keeps, not a rendered page", async () => {
		const { request } = await staticServer();

		const response = await request("/assets/entry-old.js");

		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		await expect(response.text()).resolves.toBe("Not Found");
	});
});

describe("prerendered markdownTwins", () => {
	const markdown = { headers: { Accept: "text/markdown" } };
	const browser = { headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } };

	it("serves the twin, with its own captured headers, to a request that prefers markdown", async () => {
		const { request } = await staticServer({ markdownTwins: true });

		const response = await request("/components/button", markdown);

		await expect(response.text()).resolves.toBe("# Button");
		expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
		expect(response.headers.get("Cache-Control")).toBe("max-age=60");
		expect(response.headers.get("Content-Security-Policy")).toBeNull();
		expect(response.headers.get("Vary")).toBe("Accept");
	});

	it("serves the HTML with Vary: Accept to a browser", async () => {
		const { request } = await staticServer({ markdownTwins: true });

		const response = await request("/components/button", browser);

		await expect(response.text()).resolves.toBe("<h1>Button</h1>");
		expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
		expect(response.headers.get("Vary")).toBe("Accept");
	});

	it("answers HEAD as GET, and keeps Vary: Accept on a 304", async () => {
		const { request } = await staticServer({ markdownTwins: true });
		const etag = (await request("/components/button", browser)).headers.get("ETag") ?? "";

		const head = await request("/components/button", { ...markdown, method: "HEAD" });
		const notModified = await request("/components/button", {
			headers: { ...browser.headers, "If-None-Match": etag },
		});

		expect(head.headers.get("Content-Length")).toBe("8");
		expect(head.headers.get("Vary")).toBe("Accept");
		expect(notModified.status).toBe(304);
		expect(notModified.headers.get("Vary")).toBe("Accept");
	});

	it("serves the twin of the root, of a URL with a trailing slash, and of a page that the framework renders", async () => {
		const { request } = await staticServer({ markdownTwins: true });

		const root = await request("/", markdown);
		const slash = await request("/components/button/", markdown);
		const renderedTwin = await request("/docs/rendered", markdown);
		const rendered = await request("/docs/rendered", browser);

		await expect(root.text()).resolves.toBe("# Home");
		await expect(slash.text()).resolves.toBe("# Button");
		await expect(renderedTwin.text()).resolves.toBe("# Rendered");
		await expect(rendered.text()).resolves.toBe("rendered");
		expect(rendered.headers.get("Vary")).toBe("Accept");
	});

	it("adds no Vary: Accept for a path with no twin or for the twin's own URL", async () => {
		const { request } = await staticServer({ markdownTwins: true });

		const noTwin = await request("/llms.txt", markdown);
		const twinUrl = await request("/components/button.md", markdown);
		const missing = await request("/docs/missing", markdown);

		await expect(noTwin.text()).resolves.toBe("llms");
		expect(noTwin.headers.get("Vary")).toBeNull();
		await expect(twinUrl.text()).resolves.toBe("# Button");
		expect(twinUrl.headers.get("Vary")).toBeNull();
		expect(missing.headers.get("Vary")).toBeNull();
	});

	it("adds Accept to the Vary values that the headers option sets", async () => {
		const { request } = await staticServer({
			markdownTwins: true,
			headers: () => ({ Vary: "Origin" }),
		});

		const response = await request("/components/button", browser);

		expect(response.headers.get("Vary")).toBe("Origin, Accept");
	});

	it("uses twinOf, and applies the request-path rules to the path it returns", async () => {
		const twins: Record<string, string> = {
			"/button": "/components/button.md",
			"/secret": "/.env",
			"/escape": "/../outside.md",
		};
		const { request } = await staticServer({ markdownTwins: { twinOf: (path) => twins[path] } });

		await expect((await request("/button", markdown)).text()).resolves.toBe("# Button");
		for (const path of ["/secret", "/escape"]) {
			const response = await request(path, markdown);
			await expect(response.text()).resolves.toBe("rendered");
			expect(response.headers.get("Vary")).toBeNull();
		}
	});

	it("runs rewrite only when the request does not get the twin", async () => {
		const seen: string[] = [];
		const { request } = await staticServer({
			markdownTwins: true,
			rewrite: (path) => {
				seen.push(path);
				return path;
			},
		});

		await request("/components/button", markdown);
		await request("/components/button", browser);

		expect(seen).toStrictEqual(["/components/button"]);
	});

	it("is off by default", async () => {
		const { request } = await staticServer();

		const response = await request("/components/button", markdown);

		await expect(response.text()).resolves.toBe("<h1>Button</h1>");
		expect(response.headers.get("Vary")).toBeNull();
	});
});
