import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { createServer, defaultPlugins, serverInternals } from "../create-server.js";
import { createEntry } from "../entry.js";
import { withHeaderHook } from "../header-hook.js";
import { tcp } from "../../node/tcp.js";
import { productionSetup, stubFramework, testServer } from "../../test-server.js";
import { handler, host as vercelHost } from "../../vercel/index.js";
import { buildId } from "./build-id.js";
import { requestId } from "./request-id.js";
import { runtimeEnv } from "./runtime-env.js";
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
	"docs/café.md": "# Café",
	"docs/tab\tstop.md": "# Tab",
	"components/button.data": "[data]",
	"llms.txt": "llms",
	"install.sh": "#!/bin/sh",
	"openapi.yaml": "openapi: 3.1.0",
	"feed.rss": "<rss></rss>",
	"digits.bin": "0123456789",
	"growing.txt": "0123456789",
	"legacy.htm": "<h1>Legacy</h1>",
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
		scriptHashes: {},
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
			headers: ({ path }) =>
				path === "/llms.txt" ? { "Access-Control-Allow-Origin": "https://a.example" } : undefined,
		});

		const response = await request("/llms.txt");

		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://a.example");
	});

	it("gives the headers option the path that names the file, and the path of the file", async () => {
		const { request } = await staticServer({
			headers: ({ path, file }) => ({ "X-Path": path, "X-File": file }),
			rewrite: ({ path }) => (path === "/old" ? "/components/button.md" : path),
		});

		const page = await request("/components/button");
		const rewritten = await request("/old");

		expect(page.headers.get("X-Path")).toBe("/components/button");
		expect(page.headers.get("X-File")).toBe("/components/button/index.html");
		expect(rewritten.headers.get("X-Path")).toBe("/components/button.md");
		expect(rewritten.headers.get("X-File")).toBe("/components/button.md");
	});

	it("lets the headers option replace a captured header in any case", async () => {
		const { request } = await staticServer({
			headers: ({ path }) =>
				path === "/components/button.md" ? { "Cache-Control": "private, no-cache" } : undefined,
		});

		const response = await request("/components/button.md");

		expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
	});

	it("takes a value of the headers option as Headers does: with no white space at its ends, and a number as text", async () => {
		const { request } = await staticServer({
			headers: ({ path }) =>
				path === "/llms.txt"
					? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an app in JavaScript can give a number.
						({ "Content-Type": "\ttext/html ", "Access-Control-Max-Age": 600 } as unknown as Record<
							string,
							string
						>)
					: undefined,
		});

		const response = await request("/llms.txt", { headers: { Range: "bytes=0-1" } });

		expect(response.headers.get("Content-Type")).toBe("text/html");
		expect(response.headers.get("Access-Control-Max-Age")).toBe("600");
		// Why: the server reads the type as it sends it, so the file is an HTML page with no ranges.
		expect([response.status, response.headers.get("Accept-Ranges")]).toStrictEqual([200, null]);
	});

	it("answers 500 for a value of the headers option that no header can hold", async () => {
		const { request } = await staticServer({ headers: () => ({ "X-Note": "first\nsecond" }) });

		expect((await request("/llms.txt")).status).toBe(500);
	});

	it("serves the file that rewrite names, with that file's headers", async () => {
		const { request } = await staticServer({
			rewrite: ({ path, context }) =>
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

	it("makes the ETag from the size and the time in hexadecimal, then the hash of the parts", async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-server-etag-"));
		onTestFinished(() => {
			rmSync(directory, { recursive: true, force: true });
		});
		// Why two times: one is under 2^32 milliseconds, and one is over it.
		const times = { "old.txt": 86_400_000, "new.txt": 1_767_323_045_000 };
		for (const [name, time] of Object.entries(times)) {
			writeFileSync(join(directory, name), "0123456789abcdef");
			utimesSync(join(directory, name), new Date(time), new Date(time));
		}
		const plain = await testServer({ plugins: [prerendered()], clientDirectory: directory });
		const versioned = await testServer({
			plugins: [{ name: "versioned", etagPart: () => "v1" }, prerendered()],
			clientDirectory: directory,
		});
		const etag = async (server: typeof plain, path: string) =>
			(await server.request(path)).headers.get("ETag");

		await expect(etag(plain, "/old.txt")).resolves.toBe('W/"10-5265c00"');
		await expect(etag(plain, "/new.txt")).resolves.toBe('W/"10-19b7ca98c88"');
		await expect(etag(versioned, "/new.txt")).resolves.toBe('W/"10-19b7ca98c88-O_wmlZTvZJIo6adL"');
	});

	it("gives each list of parts its own ETag when requests with other parts come between", async () => {
		const part = { value: "" };
		const { request } = await testServer({
			plugins: [{ name: "versioned", etagPart: () => part.value }, prerendered()],
			clientDirectory,
		});
		// Why 40: more lists of parts than the server keeps a hash for.
		const values = Array.from({ length: 40 }, (_, index) => `v${index}`);
		/** The ETags of three requests at one time for each value. Each can be the first with its parts. */
		const etags = async () => {
			const tags: (string | null)[][] = [];
			for (const value of values) {
				part.value = value;
				const responses = await Promise.all(
					Array.from({ length: 3 }, async () => request("/llms.txt")),
				);
				tags.push(responses.map((response) => response.headers.get("ETag")));
			}
			return tags;
		};

		const first = await etags();
		const again = await etags();

		expect(first.map((tags) => new Set(tags).size)).toStrictEqual(values.map(() => 1));
		expect(new Set(first.flat()).size).toBe(values.length);
		expect(again).toStrictEqual(first);
	});

	it("applies the request-path rules to a rewritten path", async () => {
		const rewrites: Record<string, string> = {
			"/secret": "/.env",
			"/alias": "/components//button",
			"/escape": "/../outside.txt",
		};
		const { request } = await staticServer({ rewrite: ({ path }) => rewrites[path] ?? path });

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

	it("serves common files that Hono's types lack with their own type, not application/octet-stream", async () => {
		const { request } = await staticServer();

		const types = await Promise.all(
			["/install.sh", "/openapi.yaml", "/feed.rss"].map(async (path) =>
				(await request(path)).headers.get("Content-Type"),
			),
		);

		expect(types).toStrictEqual([
			"application/x-sh",
			"text/yaml; charset=utf-8",
			"application/rss+xml",
		]);
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

	it("sends no more bytes than its Content-Length when the file grows after the lookup", async () => {
		const { request } = await staticServer();

		const response = await request("/growing.txt");
		appendFileSync(join(clientDirectory, "growing.txt"), "more");

		expect(response.headers.get("Content-Length")).toBe("10");
		await expect(response.text()).resolves.toBe("0123456789");
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
	it("revalidates a markdown file, as it does the page of its twin", async () => {
		const { request } = await testServer({ plugins: [prerendered()], clientDirectory });

		const response = await request("/index.md");

		expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
	});

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
		await expect(cacheControl("/legacy.htm")).resolves.toBe("public, max-age=0, must-revalidate");
		await expect(cacheControl("/images/logo.svg")).resolves.toBe(
			"public, max-age=3600, stale-while-revalidate=86400",
		);
		await expect(cacheControl("/components/button.md")).resolves.toBe("max-age=60");
	});

	it("uses the cacheControl option, and keeps the default of a file for undefined", async () => {
		const { request } = await staticServer({
			cacheControl: (file) => (file.startsWith("/images/") ? "public, max-age=86400" : undefined),
		});
		const cacheControl = async (path: string) => (await request(path)).headers.get("Cache-Control");

		await expect(cacheControl("/images/logo.svg")).resolves.toBe("public, max-age=86400");
		await expect(cacheControl("/install.sh")).resolves.toBe(
			"public, max-age=3600, stale-while-revalidate=86400",
		);
		await expect(cacheControl("/legacy.htm")).resolves.toBe("public, max-age=0, must-revalidate");
	});

	it("sends no Cache-Control when a header hook of an earlier plugin deletes it", async () => {
		const noCacheControl: Plugin = {
			name: "no-cache-control",
			middleware: async (context, next) =>
				withHeaderHook(context, next, (response) => {
					response.delete("Cache-Control");
				}),
		};
		const { request } = await testServer({
			plugins: [noCacheControl, assets(), prerendered()],
			clientDirectory,
		});

		expect((await request("/install.sh")).headers.get("Cache-Control")).toBeNull();
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

	it("sends the full page for a range of an HTML file, because a later stage can change it", async () => {
		const { request } = await staticServer();

		const response = await request("/components/button", { headers: { Range: "bytes=0-3" } });

		expect(response.status).toBe(200);
		expect(response.headers.get("Accept-Ranges")).toBeNull();
		await expect(response.text()).resolves.toBe("<h1>Button</h1>");
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

	it("serves the assets directory that the build recorded with the immutable cache", async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-server-assets-dir-"));
		onTestFinished(() => {
			rmSync(directory, { recursive: true, force: true });
		});
		mkdirSync(join(directory, "blog-assets/build"), { recursive: true });
		writeFileSync(join(directory, "blog-assets/build/entry-abc123.js"), "export {};");
		writeFileSync(
			join(directory, ".app-server.json"),
			JSON.stringify({
				assetsPath: "/blog-assets/build/",
				prerendered: [],
				headers: {},
				scriptHashes: {},
			}),
		);
		const { request } = await testServer({
			plugins: [assets(), prerendered()],
			clientDirectory: directory,
		});

		const hashed = await request("/blog-assets/build/entry-abc123.js");
		const missing = await request("/blog-assets/build/entry-old.js");

		expect(hashed.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		expect([missing.status, missing.headers.get("Cache-Control")]).toStrictEqual([404, "no-store"]);
	});

	it("stops startup for a recorded assets path that is not a URL path prefix", async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-server-bad-assets-dir-"));
		onTestFinished(() => {
			rmSync(directory, { recursive: true, force: true });
		});
		writeFileSync(
			join(directory, ".app-server.json"),
			JSON.stringify({ assetsPath: "/", prerendered: [], headers: {}, scriptHashes: {} }),
		);

		await expect(testServer({ plugins: [assets()], clientDirectory: directory })).rejects.toThrow(
			'the "assetsPath" must be a URL path that starts and ends with "/"',
		);
	});
});

describe("compressed copies from the build", () => {
	const text = "export const value = 1;\n".repeat(100);
	const page = `<html><head></head><body>${text}</body></html>`;
	const withBrotli = { headers: { "Accept-Encoding": "gzip, deflate, br" } };
	const gzip = { headers: { "Accept-Encoding": "gzip" } };
	const contents: Record<string, string> = {
		"assets/copy-abc123.js": text,
		"copy.txt": text,
		"plain/index.html": page,
	};
	for (const [path, content] of Object.entries(contents)) {
		mkdirSync(dirname(join(clientDirectory, path)), { recursive: true });
		writeFileSync(join(clientDirectory, path), content);
		writeFileSync(join(clientDirectory, dirname(path), `.${basename(path)}.gz`), gzipSync(content));
		writeFileSync(
			join(clientDirectory, dirname(path), `.${basename(path)}.br`),
			brotliCompressSync(content),
		);
	}
	// Why: a build that wrote no brotli copy, because it was not smaller than the gzip copy.
	writeFileSync(join(clientDirectory, "gzip-only.txt"), text);
	writeFileSync(join(clientDirectory, ".gzip-only.txt.gz"), gzipSync(text));

	it("sends the brotli copy to a request that accepts br, with its length and no ranges", async () => {
		const { request } = await staticServer();

		const served: readonly (readonly [string, string])[] = [
			["/assets/copy-abc123.js", text],
			["/copy.txt", text],
			["/plain", page],
		];

		for (const [path, content] of served) {
			const response = await request(path, withBrotli);
			const body = new Uint8Array(await response.arrayBuffer());

			expect(response.headers.get("Content-Encoding")).toBe("br");
			expect(response.headers.get("Content-Length")).toBe(String(body.byteLength));
			expect(response.headers.get("Vary")).toBe("Accept-Encoding");
			expect(response.headers.get("Accept-Ranges")).toBeNull();
			expect(brotliDecompressSync(body).toString()).toBe(content);
		}
	});

	it("sends the gzip copy to a request that does not accept br, or when no brotli copy exists", async () => {
		const { request } = await staticServer();

		const copy = await request("/copy.txt", gzip);
		const gzipOnly = await request("/gzip-only.txt", withBrotli);

		for (const response of [copy, gzipOnly]) {
			expect(response.headers.get("Content-Encoding")).toBe("gzip");
			expect(response.headers.get("Vary")).toBe("Accept-Encoding");
			expect(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe(text);
		}
	});

	it("follows the q values of Accept-Encoding, with q=0 as a refusal", async () => {
		const { request } = await staticServer();
		const encodings: Record<string, string | null> = {
			"br;q=0, gzip": "gzip",
			"gzip;q=1, br;q=0.5": "gzip",
			"br;q=0.5, gzip;q=0.5": "br",
			"*": "br",
			"*;q=0.5, br;q=0": "gzip",
			"identity, gzip;q=0.5": null,
			"br;q=0, gzip;q=0": null,
			"*;q=0": null,
			deflate: null,
		};

		for (const [header, encoding] of Object.entries(encodings)) {
			const response = await request("/copy.txt", { headers: { "Accept-Encoding": header } });

			expect([header, response.headers.get("Content-Encoding")]).toStrictEqual([header, encoding]);
		}
	});

	it("sends the file with Vary: Accept-Encoding to a request that accepts no copy", async () => {
		const { request } = await staticServer();

		const response = await request("/assets/copy-abc123.js");

		expect(response.headers.get("Content-Encoding")).toBeNull();
		expect(response.headers.get("Vary")).toBe("Accept-Encoding");
		await expect(response.text()).resolves.toBe(text);
	});

	it("gives each encoding its own ETag", async () => {
		const { request } = await staticServer();
		const etag = async (init?: RequestInit) =>
			(await request("/copy.txt", init)).headers.get("ETag") ?? "";

		const tags = [await etag(withBrotli), await etag(gzip), await etag()];

		expect(new Set(tags).size).toBe(3);
	});

	it("answers 304 only to the ETag of the encoding that the request gets", async () => {
		const { request } = await staticServer();
		const brotliTag = (await request("/copy.txt", withBrotli)).headers.get("ETag") ?? "";
		const revalidate = async (accept: string) =>
			request("/copy.txt", { headers: { "Accept-Encoding": accept, "If-None-Match": brotliTag } });

		const notModified = await revalidate("br");
		const gzipped = await revalidate("gzip");

		expect([notModified.status, gzipped.status]).toStrictEqual([304, 200]);
		expect(notModified.headers.get("ETag")).toBe(brotliTag);
		expect(notModified.headers.get("Vary")).toBe("Accept-Encoding");
		expect(gzipped.headers.get("Content-Encoding")).toBe("gzip");
	});

	it("answers HEAD with the length of the copy", async () => {
		const { request } = await staticServer();

		const head = await request("/copy.txt", { method: "HEAD", ...gzip });

		expect(head.headers.get("Content-Length")).toBe(String(gzipSync(text).byteLength));
		await expect(head.text()).resolves.toBe("");
	});

	it("never sends a copy for a file that its headers already encode", async () => {
		const { request } = await staticServer({
			headers: ({ path }) => (path === "/copy.txt" ? { "Content-Encoding": "gzip" } : undefined),
		});

		const response = await request("/copy.txt", withBrotli);

		expect(response.headers.get("Content-Encoding")).toBe("gzip");
		expect(response.headers.get("Content-Length")).toBe(String(text.length));
		await expect(response.text()).resolves.toBe(text);
	});

	it("gives a copy no URL of its own, so a skip rule for its file also blocks it", async () => {
		const { request } = await staticServer({ skip: (path) => path === "/copy.txt" });

		for (const path of ["/copy.txt", "/.copy.txt.gz", "/copy.txt.gz", "/.copy.txt.br"]) {
			await expect((await request(path, withBrotli)).text()).resolves.toBe("rendered");
		}
	});

	it("never sends a copy for a response marked no-transform", async () => {
		const { request } = await staticServer({
			headers: ({ path }) =>
				path === "/copy.txt" ? { "Cache-Control": "no-transform" } : undefined,
		});

		const response = await request("/copy.txt", withBrotli);

		expect(response.headers.get("Content-Encoding")).toBeNull();
		await expect(response.text()).resolves.toBe(text);
	});

	it("never sends a copy for a response that an earlier stage's header hook marks no-transform", async () => {
		const noTransform: Plugin = {
			name: "no-transform",
			middleware: async (context, next) =>
				withHeaderHook(context, next, (response) => {
					response.set("Cache-Control", "public, no-transform");
				}),
		};
		const { request } = await testServer({
			plugins: [noTransform, prerendered()],
			clientDirectory,
		});

		for (const path of ["/copy.txt", "/plain"]) {
			const response = await request(path, withBrotli);

			expect(response.headers.get("Cache-Control")).toBe("public, no-transform");
			expect(response.headers.get("Content-Encoding")).toBeNull();
		}
	});

	it("lets the header hook of an outer stage have the last word on no-transform", async () => {
		const sets = (name: string, value: string): Plugin => ({
			name,
			middleware: async (context, next) =>
				withHeaderHook(context, next, (response) => {
					response.set("Cache-Control", value);
				}),
		});
		const forbids = sets("forbids", "public, no-transform");
		const allows = sets("allows", "public, max-age=60");
		const outerForbids = await testServer({
			plugins: [forbids, allows, prerendered()],
			clientDirectory,
		});
		const outerAllows = await testServer({
			plugins: [allows, forbids, prerendered()],
			clientDirectory,
		});

		const kept = await outerForbids.request("/copy.txt", withBrotli);
		const copied = await outerAllows.request("/copy.txt", withBrotli);

		expect([kept.headers.get("Cache-Control"), kept.headers.get("Content-Encoding")]).toStrictEqual(
			["public, no-transform", null],
		);
		expect([
			copied.headers.get("Cache-Control"),
			copied.headers.get("Content-Encoding"),
		]).toStrictEqual(["public, max-age=60", "br"]);
	});

	it("lets an app hook mark no-transform by a header that a built-in hook sets", async () => {
		const byRequestId: Plugin = {
			name: "by-request-id",
			middleware: async (context, next) =>
				withHeaderHook(context, next, (response) => {
					if (response.has("X-Request-Id")) {
						response.set("Cache-Control", "public, no-transform");
					}
				}),
		};
		const { request } = await testServer({
			plugins: [byRequestId, requestId(), prerendered()],
			clientDirectory,
		});

		const response = await request("/copy.txt", withBrotli);

		expect(response.headers.get("Cache-Control")).toBe("public, no-transform");
		expect(response.headers.get("Content-Encoding")).toBeNull();
	});

	it("sends the file, not its copy, when a hook that a stage adds to headerHooks marks it no-transform", async () => {
		const marks: Plugin = {
			name: "marks",
			middleware: async (context, next) => {
				context.get("headerHooks")?.push((headers) => {
					headers.set("Cache-Control", "public, no-transform");
				});
				await next();
			},
		};
		const { request } = await testServer({ plugins: [marks, prerendered()], clientDirectory });

		const response = await request("/copy.txt", withBrotli);

		expect(response.headers.get("Cache-Control")).toBe("public, no-transform");
		expect(response.headers.get("Content-Encoding")).toBeNull();
	});

	it("calls the paths of buildId one time for a file with a copy", async () => {
		const paths = vi.fn<(path: string) => boolean>(() => false);
		const { request } = await testServer({
			plugins: [buildId({ value: "b1", paths }), prerendered()],
			clientDirectory,
		});

		const response = await request("/copy.txt", withBrotli);

		expect(response.headers.get("Content-Encoding")).toBe("br");
		expect(paths).toHaveBeenCalledTimes(1);
	});

	it("sends the HTML file, not its copy, when runtimeEnv adds values to the page", async () => {
		const withValues = await testServer({
			plugins: [
				runtimeEnv(z.object({ PUBLIC_A: z.string() }), { source: { PUBLIC_A: "1" } }),
				prerendered(),
			],
			clientDirectory,
		});
		const noValues = await testServer({
			plugins: [
				runtimeEnv(z.object({ SECRET: z.string() }), { source: { SECRET: "1" } }),
				prerendered(),
			],
			clientDirectory,
		});

		const injected = await withValues.request("/plain", withBrotli);
		const copied = await noValues.request("/plain", withBrotli);

		expect(injected.headers.get("Content-Encoding")).toBeNull();
		await expect(injected.text()).resolves.toContain('<script id="app-server-public-env"');
		expect(copied.headers.get("Content-Encoding")).toBe("br");
	});
});

describe("a page that a stage with rewritesHtml changes", () => {
	const banner = "<!-- banner -->";
	const pages: Record<string, string> = {
		"/banner/small": "<!doctype html><html><body><h1>Small</h1></body></html>",
		// Why this size: the page is too large for one chunk, so it streams.
		"/banner/large": `<!doctype html><html><head></head><body>${"<p>The quick brown fox jumps over the lazy dog.</p>\n".repeat(6000)}</body></html>`,
	};
	for (const [path, page] of Object.entries(pages)) {
		mkdirSync(join(clientDirectory, path), { recursive: true });
		writeFileSync(join(clientDirectory, path, "index.html"), page);
		writeFileSync(join(clientDirectory, path, ".index.html.gz"), gzipSync(page));
		writeFileSync(join(clientDirectory, path, ".index.html.br"), brotliCompressSync(page));
	}

	/** `response` with the banner after the last byte of an HTML body. */
	function addBanner(response: Response): Response {
		const html = response.headers.get("Content-Type")?.startsWith("text/html") ?? false;
		if (!html || response.body == null) {
			return response;
		}
		const withBanner = new TransformStream<Uint8Array, Uint8Array>({
			flush(controller) {
				controller.enqueue(new TextEncoder().encode(banner));
			},
		});
		return new Response(response.body.pipeThrough(withBanner), response);
	}

	/** The plugin of the README and of the changelog, as an app writes it. */
	const addsBanner: Plugin = {
		name: "adds-banner",
		middleware: async (context, next) => {
			context.set("rewritesHtml", true);
			await next();
			context.res = addBanner(context.res);
		},
	};

	/** The URL of a server on the node host or on the vercel host, with the plugin before the static stages. */
	async function serving(hostName: "node" | "vercel"): Promise<string> {
		const plugins = defaultPlugins({ beforeStatic: [addsBanner] });
		if (hostName === "node") {
			const { internals, framework } = await testServer({
				plugins,
				clientDirectory,
				options: { listeners: [tcp({ port: 0, host: "127.0.0.1" })] },
			});
			const server = await internals.listen(framework, []);
			onTestFinished(async () => server.shutdown());
			return server.urls[0] ?? "";
		}
		const listener = handler(
			createEntry({
				app: createServer({ plugins, logger: { log: () => {} } }),
				host: vercelHost,
				clientDirectory,
				framework: () => stubFramework(),
			}),
		);
		const server = createHttpServer((incoming, outgoing) => {
			void listener(incoming, outgoing);
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		onTestFinished(
			async () =>
				new Promise<void>((resolve) => {
					server.close(() => {
						resolve();
					});
				}),
		);
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	/** What a GET that accepts `encoding` gets on the wire: the status, the text, and whether the length is right. */
	async function wire(url: URL, encoding: string) {
		const response = await new Promise<IncomingMessage>((resolve, reject) => {
			httpRequest(url, { headers: { "Accept-Encoding": encoding } }, resolve)
				.once("error", reject)
				.end();
		});
		const chunks: Buffer[] = [];
		for await (const chunk of response) {
			chunks.push(chunk as Buffer);
		}
		const body = Buffer.concat(chunks);
		const decoders: Record<string, (bytes: Buffer) => Buffer> = {
			gzip: gunzipSync,
			br: brotliDecompressSync,
		};
		const decode = decoders[response.headers["content-encoding"] ?? ""];
		const length = response.headers["content-length"];
		return {
			status: response.statusCode,
			text: (decode == null ? body : decode(body)).toString(),
			rightLength: length == null || length === String(body.byteLength),
		};
	}

	it.each(["node", "vercel"] as const)(
		"goes out whole on the %s host: small or large, to a client with or without gzip or brotli",
		async (hostName) => {
			const base = await serving(hostName);

			for (const [path, page] of Object.entries(pages)) {
				for (const encoding of ["identity", "gzip", "br"]) {
					const sent = await wire(new URL(path, base), encoding);

					expect({ path, encoding, ...sent }).toStrictEqual({
						path,
						encoding,
						status: 200,
						text: `${page}${banner}`,
						rightLength: true,
					});
				}
			}
		},
	);

	it("has no ETag and no length, also not from the headers option, so the ETag of its file gets the full page", async () => {
		const plain = await staticServer();
		const fileTag = (await plain.request("/banner/small")).headers.get("ETag") ?? "";
		const ofFile = { ETag: '"v1"', "Content-Length": "5" };
		const { request } = await testServer({
			plugins: [
				addsBanner,
				prerendered({ headers: ({ path }) => (path === "/plain" ? ofFile : undefined) }),
			],
			clientDirectory,
		});

		const revalidated = await request("/banner/small", { headers: { "If-None-Match": fileTag } });
		const tagged = await request("/plain", { headers: { "If-None-Match": '"v1"' } });

		expect(fileTag).not.toBe("");
		expect([revalidated.status, revalidated.headers.get("ETag")]).toStrictEqual([200, null]);
		expect([
			tagged.status,
			tagged.headers.get("ETag"),
			tagged.headers.get("Content-Length"),
		]).toStrictEqual([200, null, null]);
		await expect(revalidated.text()).resolves.toBe(`${pages["/banner/small"]}${banner}`);
	});

	it("answers HEAD with no length, and leaves a file that is not HTML as it is", async () => {
		const { request } = await testServer({ plugins: [addsBanner, prerendered()], clientDirectory });

		const head = await request("/banner/small", { method: "HEAD" });
		const text = await request("/copy.txt", { headers: { "Accept-Encoding": "br" } });

		expect([head.status, head.headers.get("Content-Length")]).toStrictEqual([200, null]);
		expect(text.headers.get("Content-Encoding")).toBe("br");
		expect(text.headers.get("ETag")).toMatch(/^W\/"/u);
		expect(text.headers.get("Content-Length")).not.toBeNull();
	});
});

/** The headers of a response that tell a client and a cache about the twin. */
function negotiation(response: Response): { vary: string | null; link: string | null } {
	return { vary: response.headers.get("Vary"), link: response.headers.get("Link") };
}

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
		expect(negotiation(response)).toStrictEqual({ vary: "Accept", link: null });
	});

	it("serves the HTML with Vary: Accept and a Link to the twin to a browser", async () => {
		const { request } = await staticServer({ markdownTwins: true });

		const response = await request("/components/button", browser);

		await expect(response.text()).resolves.toBe("<h1>Button</h1>");
		expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
		expect(negotiation(response)).toStrictEqual({
			vary: "Accept",
			link: '</components/button.md>; rel="alternate"; type="text/markdown"',
		});
	});

	it("percent-encodes the Link to a twin, a tab included", async () => {
		const { request } = await staticServer({ markdownTwins: true });

		const accent = await request("/docs/caf%C3%A9", browser);
		const tab = await request("/docs/tab%09stop", browser);

		expect(accent.headers.get("Link")).toBe(
			'</docs/caf%C3%A9.md>; rel="alternate"; type="text/markdown"',
		);
		expect(tab.headers.get("Link")).toBe(
			'</docs/tab%09stop.md>; rel="alternate"; type="text/markdown"',
		);
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
		expect(negotiation(rendered)).toStrictEqual({
			vary: "Accept",
			link: '</docs/rendered.md>; rel="alternate"; type="text/markdown"',
		});
	});

	it("adds the headers where the response leaves, so the framework's response needs no copy", async () => {
		const rendered = new Response("rendered", { headers: { "Content-Type": "text/html" } });
		let seen: Response | undefined;
		const watch: Plugin = {
			name: "watch",
			middleware: async (context, next) => {
				await next();
				seen = context.res;
			},
		};
		const { request } = await testServer({
			plugins: [watch, prerendered({ markdownTwins: true })],
			clientDirectory,
			render: async () => rendered,
		});

		const response = await request("/docs/rendered", browser);

		expect(seen).toBe(rendered);
		expect(negotiation(response)).toStrictEqual({
			vary: "Accept",
			link: '</docs/rendered.md>; rel="alternate"; type="text/markdown"',
		});
	});

	it("adds no Vary: Accept and no Link for a path with no twin or for the twin's own URL", async () => {
		const { request } = await staticServer({ markdownTwins: true });

		const noTwin = await request("/llms.txt", markdown);
		const twinUrl = await request("/components/button.md", markdown);
		const missing = await request("/docs/missing", markdown);

		await expect(noTwin.text()).resolves.toBe("llms");
		expect(negotiation(noTwin)).toStrictEqual({ vary: null, link: null });
		await expect(twinUrl.text()).resolves.toBe("# Button");
		expect(negotiation(twinUrl)).toStrictEqual({ vary: null, link: null });
		expect(negotiation(missing)).toStrictEqual({ vary: null, link: null });
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
		const { request } = await staticServer({
			markdownTwins: { twinOf: ({ path }) => twins[path] },
		});

		await expect((await request("/button", markdown)).text()).resolves.toBe("# Button");
		for (const path of ["/secret", "/escape"]) {
			const response = await request(path, markdown);
			await expect(response.text()).resolves.toBe("rendered");
			expect(response.headers.get("Vary")).toBeNull();
		}
	});

	it("gives twinOf the request, so a request with a query can skip the twin", async () => {
		const { request } = await staticServer({
			markdownTwins: {
				twinOf: ({ path, context }) =>
					new URL(context.req.url).search === "" ? `${path}.md` : undefined,
			},
		});

		const twin = await request("/components/button", markdown);
		const query = await request("/components/button?q=filter", markdown);

		await expect(twin.text()).resolves.toBe("# Button");
		await expect(query.text()).resolves.toBe("<h1>Button</h1>");
		expect(negotiation(query)).toStrictEqual({ vary: null, link: null });
	});

	it("gives no default twin to a request that rewrite changes", async () => {
		const { request } = await staticServer({
			markdownTwins: true,
			rewrite: ({ path, context }) => (new URL(context.req.url).search === "" ? path : "/search"),
		});

		const twin = await request("/components/button", markdown);
		const query = await request("/components/button?q=filter", markdown);

		await expect(twin.text()).resolves.toBe("# Button");
		await expect(query.text()).resolves.toBe("rendered");
		expect(negotiation(query)).toStrictEqual({ vary: null, link: null });
	});

	it("gives the twin from twinOf to a request that rewrite changes", async () => {
		const { request } = await staticServer({
			markdownTwins: { twinOf: ({ path }) => `${path}.md` },
			rewrite: () => "/search",
		});

		const response = await request("/components/button", markdown);

		await expect(response.text()).resolves.toBe("# Button");
	});

	it("is off by default", async () => {
		const { request } = await staticServer();

		const response = await request("/components/button", markdown);

		await expect(response.text()).resolves.toBe("<h1>Button</h1>");
		expect(response.headers.get("Vary")).toBeNull();
	});
});

describe("prerendered markdownTwins in development", () => {
	const markdown = { headers: { Accept: "text/markdown" } };
	const browser = { headers: { Accept: "text/html,*/*;q=0.8" } };

	/**
	 * A development server whose framework renders each `.md` URL as markdown,
	 * with a 304 for an `If-None-Match`. `/docs/missing.md` is a markdown 404,
	 * and `/tags/react.md` is an HTML page. With no `prerenderedPaths`, it is
	 * a framework that finds them only during the build.
	 */
	async function devServer(options: PrerenderedOptions, prerenderedPaths?: readonly string[]) {
		const seen: string[] = [];
		const framework = stubFramework(async (request) => {
			const { pathname } = new URL(request.url);
			seen.push(`${request.method} ${pathname}`);
			const type = { "Content-Type": "Text/Markdown; charset=utf-8" };
			if (pathname === "/docs/missing.md") {
				return new Response("# Not Found", {
					status: 404,
					headers: { "Content-Type": "text/markdown" },
				});
			}
			if (!pathname.endsWith(".md") || pathname === "/tags/react.md") {
				return new Response("rendered", { headers: { "Content-Type": "text/html" } });
			}
			return request.headers.has("If-None-Match")
				? new Response(null, { status: 304 })
				: new Response(`# ${pathname}`, { headers: type });
		});
		const logger = { log: () => {} };
		const app = createServer({
			plugins: [assets(), prerendered(options)],
			logger,
			listeners: [tcp({ port: 0, host: "127.0.0.1" })],
		});
		const internals = serverInternals(app);
		await internals?.prepare({
			...(await productionSetup({ clientDirectory, logger })),
			mode: "development",
			devServer: async (_, next) => next(),
			prerenderedPaths,
		});
		// Why a listener: the Node.js listener's request differs from the `Request` of `app.request`.
		const server = await internals?.listen(framework, []);
		onTestFinished(async () => server?.shutdown());
		const request = async (path: string, init?: RequestInit) =>
			fetch(new URL(path, server?.urls[0]), init);
		return { request, seen };
	}

	it("answers a request that prefers markdown with the framework's answer for the twin", async () => {
		const { request } = await devServer({ markdownTwins: true });

		const response = await request("/docs/button", markdown);

		await expect(response.text()).resolves.toBe("# /docs/button.md");
		expect(negotiation(response)).toStrictEqual({ vary: "Accept", link: null });
	});

	it("keeps the twin's 304 and a tab in the twin's path", async () => {
		const { request, seen } = await devServer({ markdownTwins: true });

		const notModified = await request("/docs/button", {
			headers: { ...markdown.headers, "If-None-Match": '"v1"' },
		});
		const tab = await request("/docs/tab%09stop", markdown);

		expect(notModified.status).toBe(304);
		expect(negotiation(notModified)).toStrictEqual({ vary: "Accept", link: null });
		await expect(tab.text()).resolves.toBe("# /docs/tab%09stop.md");
		expect(seen).toStrictEqual(["GET /docs/button.md", "GET /docs/tab%09stop.md"]);
	});

	it("answers HEAD with the twin, and the root with /index.md", async () => {
		const { request, seen } = await devServer({ markdownTwins: true });

		await request("/", { ...markdown, method: "HEAD" });

		expect(seen).toStrictEqual(["HEAD /index.md"]);
	});

	it("gives the HTML when the twin is not markdown, to a browser, and for a skipped path", async () => {
		const { request, seen } = await devServer({
			markdownTwins: true,
			skip: (path) => path === "/app",
		});

		const missing = await request("/docs/missing", markdown);
		const html = await request("/tags/react", markdown);
		const page = await request("/docs/button", browser);
		const skipped = await request("/app", markdown);

		await expect(missing.text()).resolves.toBe("rendered");
		await expect(html.text()).resolves.toBe("rendered");
		await expect(page.text()).resolves.toBe("rendered");
		await expect(skipped.text()).resolves.toBe("rendered");
		expect(seen).toStrictEqual([
			"GET /docs/missing.md",
			"GET /docs/missing",
			"GET /tags/react.md",
			"GET /tags/react",
			"GET /docs/button",
			"GET /app",
		]);
	});

	it("asks only for a twin that the build will prerender, when the framework knows them", async () => {
		const { request, seen } = await devServer({ markdownTwins: true }, ["/docs/button.md"]);
		const none = await devServer({ markdownTwins: true }, []);

		const twin = await request("/docs/button", markdown);
		const notPrerendered = await request("/docs/other", markdown);
		const noPaths = await none.request("/docs/button", markdown);

		await expect(twin.text()).resolves.toBe("# /docs/button.md");
		await expect(notPrerendered.text()).resolves.toBe("rendered");
		await expect(noPaths.text()).resolves.toBe("rendered");
		expect([...seen, ...none.seen]).toStrictEqual([
			"GET /docs/button.md",
			"GET /docs/other",
			"GET /docs/button",
		]);
	});

	it("asks the framework for no twin whose URL changes its path", async () => {
		const skip = (path: string) => path.startsWith("/private");
		const backslash = await devServer({ markdownTwins: true, skip });
		const dots = await devServer({
			markdownTwins: { twinOf: ({ path }) => `/docs/%2e%2e${path}.md` },
		});

		await expect((await backslash.request("/docs%5C..%5Cprivate", markdown)).text()).resolves.toBe(
			"rendered",
		);
		await expect((await dots.request("/page", markdown)).text()).resolves.toBe("rendered");
		expect([...backslash.seen, ...dots.seen]).toStrictEqual([
			"GET /docs%5C..%5Cprivate",
			"GET /page",
		]);
	});

	it("gives twinOf the request, so a request with a query can skip the twin", async () => {
		const { request, seen } = await devServer({
			markdownTwins: {
				twinOf: ({ path, context }) =>
					new URL(context.req.url).search === "" ? `${path}.md` : undefined,
			},
		});

		await expect((await request("/docs/button", markdown)).text()).resolves.toBe(
			"# /docs/button.md",
		);
		await expect((await request("/docs/button?q=filter", markdown)).text()).resolves.toBe(
			"rendered",
		);
		expect(seen).toStrictEqual(["GET /docs/button.md", "GET /docs/button"]);
	});

	it("asks for no default twin for a request that rewrite changes", async () => {
		const { request, seen } = await devServer({
			markdownTwins: true,
			rewrite: ({ path, context }) => (new URL(context.req.url).search === "" ? path : "/search"),
		});

		await request("/docs/button", markdown);
		await expect((await request("/docs/button?q=filter", markdown)).text()).resolves.toBe(
			"rendered",
		);
		expect(seen).toStrictEqual(["GET /docs/button.md", "GET /docs/button"]);
	});

	it("uses twinOf, and is off by default", async () => {
		const mapped = await devServer({
			markdownTwins: { twinOf: ({ path }) => `/markdown${path}.md` },
		});
		const off = await devServer({});

		await expect((await mapped.request("/docs/button", markdown)).text()).resolves.toBe(
			"# /markdown/docs/button.md",
		);
		await expect((await off.request("/docs/button", markdown)).text()).resolves.toBe("rendered");
	});
});
