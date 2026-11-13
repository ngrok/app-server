import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testServer } from "../../test-server.js";
import { defaultPlugins } from "../create-server.js";
import { withHeaderHook } from "../header-hook.js";
import type { Plugin } from "../types.js";
import { contentSecurityPolicy, securityHeaders } from "./security-headers.js";
import { prerendered } from "./static.js";

describe("securityHeaders", () => {
	it("sets the defaults, and sets HSTS on an HTTPS request only", async () => {
		const { request } = await testServer({ plugins: [securityHeaders()] });

		const http = await request("http://localhost/");
		const https = await request("https://localhost/");

		const names = [
			"X-Content-Type-Options",
			"Referrer-Policy",
			"Cross-Origin-Opener-Policy",
			"Content-Security-Policy",
			"Permissions-Policy",
		];
		expect(Object.fromEntries(names.map((name) => [name, http.headers.get(name)]))).toStrictEqual({
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "strict-origin-when-cross-origin",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Content-Security-Policy": null,
			"Permissions-Policy": null,
		});
		expect(http.headers.get("Strict-Transport-Security")).toBeNull();
		expect(https.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
	});

	it("replaces or turns off a default, and keeps a header that the response sets", async () => {
		const { request } = await testServer({
			plugins: [
				securityHeaders({
					headers: {
						"Cross-Origin-Opener-Policy": "same-origin-allow-popups",
						"X-Content-Type-Options": false,
					},
				}),
			],
			render: async () =>
				new Response("x", {
					headers: { "Content-Type": "text/html", "Referrer-Policy": "no-referrer" },
				}),
		});

		const response = await request("/");

		expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
		expect(response.headers.get("X-Content-Type-Options")).toBeNull();
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	it("sets a Permissions-Policy, and keeps the policy of a response that has one", async () => {
		const { request } = await testServer({
			plugins: [
				securityHeaders({
					headers: { "Permissions-Policy": "camera=(), microphone=(), geolocation=()" },
				}),
			],
			render: async (rendered) =>
				new Response("x", {
					headers:
						new URL(rendered.url).pathname === "/call"
							? { "Permissions-Policy": "camera=(self)" }
							: {},
				}),
		});

		expect((await request("/")).headers.get("Permissions-Policy")).toBe(
			"camera=(), microphone=(), geolocation=()",
		);
		expect((await request("/call")).headers.get("Permissions-Policy")).toBe("camera=(self)");
	});

	it("adds a set Content-Security-Policy next to the policy of the response", async () => {
		const { request } = await testServer({
			plugins: [
				securityHeaders({ headers: { "Content-Security-Policy": "frame-ancestors 'none'" } }),
			],
			render: async () =>
				new Response("x", {
					headers: { "Content-Type": "text/html", "Content-Security-Policy": "script-src 'self'" },
				}),
		});

		const response = await request("/");

		expect(response.headers.get("Content-Security-Policy")).toBe(
			"script-src 'self', frame-ancestors 'none'",
		);
	});

	it("is in the default pipeline, and the securityHeaders option turns it off", async () => {
		const on = await testServer({ plugins: defaultPlugins() });
		const off = await testServer({ plugins: defaultPlugins({ securityHeaders: false }) });

		expect((await on.request("/")).headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect((await off.request("/")).headers.get("X-Content-Type-Options")).toBeNull();
	});

	it("puts a policy written over several lines on one line", async () => {
		const { request } = await testServer({
			plugins: [
				securityHeaders({
					headers: {
						"Content-Security-Policy": "\n  default-src 'self';\n  frame-ancestors 'none'\n",
					},
				}),
			],
		});

		const response = await request("/");

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Security-Policy")).toBe(
			"default-src 'self'; frame-ancestors 'none'",
		);
	});

	it("stops startup for a value that a header cannot hold, such as a curly quote", () => {
		const value = "frame-ancestors \u2018none\u2019";

		expect(() => securityHeaders({ headers: { "Content-Security-Policy": value } })).toThrow(
			`The Content-Security-Policy of securityHeaders must be a value that a header can hold, not ${JSON.stringify(value)}.`,
		);
		expect(() => securityHeaders({ headers: { "Permissions-Policy": "camera=()\u0000" } })).toThrow(
			"The Permissions-Policy of securityHeaders",
		);
	});

	it("does not change a response object that the framework sends again", async () => {
		const shared = new Response(null, {
			headers: { "Content-Type": "text/html", "Content-Security-Policy": "img-src 'self'" },
		});
		const { request } = await testServer({
			plugins: [
				securityHeaders({ headers: { "Content-Security-Policy": "frame-ancestors 'none'" } }),
			],
			render: async () => shared,
		});

		await request("/");
		const second = await request("/");

		expect(second.headers.get("Content-Security-Policy")).toBe(
			"img-src 'self', frame-ancestors 'none'",
		);
		expect(shared.headers.get("Content-Security-Policy")).toBe("img-src 'self'");
	});
});

const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-csp-"));
const THEME_SCRIPT = "document.documentElement.dataset.theme = 'dark';";
function sha256(text: string): string {
	return createHash("sha256").update(text).digest("base64");
}
for (const [path, content] of Object.entries({
	"about/index.html": `<script>${THEME_SCRIPT}</script>`,
	"new.html": `<script>${THEME_SCRIPT}</script>`,
	".app-server.json": JSON.stringify({
		prerendered: ["/about"],
		headers: {},
		scriptHashes: { "/about/index.html": [sha256(THEME_SCRIPT)] },
	}),
})) {
	mkdirSync(dirname(join(clientDirectory, path)), { recursive: true });
	writeFileSync(join(clientDirectory, path), content);
}

afterAll(() => {
	rmSync(clientDirectory, { recursive: true, force: true });
});

describe("contentSecurityPolicy", () => {
	const csp = contentSecurityPolicy({ policy: ({ scriptSrc }) => `script-src ${scriptSrc}` });

	it("trusts a rendered document's scripts by a new nonce for each request, the nonce that the render used", async () => {
		const { request } = await testServer({
			plugins: [csp],
			render: async (_request, context) =>
				new Response(`<script nonce="${context.get("cspNonce") ?? ""}"></script>`, {
					headers: { "Content-Type": "text/html" },
				}),
		});

		const first = await request("/");
		const second = await request("/");
		const firstNonce = /nonce="(?<nonce>[^"]+)"/u.exec(await first.text())?.groups?.nonce;
		const secondNonce = /nonce="(?<nonce>[^"]+)"/u.exec(await second.text())?.groups?.nonce;

		expect(firstNonce).toMatch(/^[\w+/]{22}==$/u);
		expect(secondNonce).not.toBe(firstNonce);
		expect(first.headers.get("Content-Security-Policy")).toBe(
			`script-src 'nonce-${firstNonce}' 'strict-dynamic'`,
		);
	});

	it("gives each of 1,000 requests its own nonce of 16 bytes in which each byte varies", async () => {
		const { request } = await testServer({
			plugins: [csp],
			render: async () => new Response("x", { headers: { "Content-Type": "text/html" } }),
		});

		const responses = await Promise.all(Array.from({ length: 1000 }, async () => request("/")));
		const nonces = responses.map(
			(response) =>
				/'nonce-(?<nonce>[^']+)'/u.exec(response.headers.get("Content-Security-Policy") ?? "")
					?.groups?.nonce ?? "",
		);
		const valuesOfByte = Array.from(
			{ length: 16 },
			(_, index) => new Set(nonces.map((nonce) => atob(nonce).codePointAt(index))).size,
		);

		expect(new Set(nonces).size).toBe(1000);
		// Why `[AQgw]`: the last character of 16 bytes in base64 holds 2 bits.
		expect(nonces.filter((nonce) => !/^[A-Za-z0-9+/]{21}[AQgw]==$/u.test(nonce))).toStrictEqual([]);
		// Why 200: 1,000 random bytes take about 251 of the 256 values.
		expect(valuesOfByte.filter((values) => values < 200)).toStrictEqual([]);
	});

	it("trusts a prerendered document's inline scripts by their hashes, and its modules by 'self'", async () => {
		const { request } = await testServer({ plugins: [csp, prerendered()], clientDirectory });

		const response = await request("/about");

		await expect(response.text()).resolves.toContain(THEME_SCRIPT);
		expect(response.headers.get("Content-Security-Policy")).toBe(
			`script-src 'self' 'sha256-${sha256(THEME_SCRIPT)}'`,
		);
	});

	it("sets the policy on a 304 for a prerendered document, so a revalidated copy keeps the policy", async () => {
		const { request } = await testServer({
			plugins: [
				securityHeaders({ headers: { "Content-Security-Policy": "frame-ancestors 'none'" } }),
				csp,
				prerendered(),
			],
			clientDirectory,
		});
		const etag = (await request("/about")).headers.get("ETag") ?? "";

		const response = await request("/about", { headers: { "If-None-Match": etag } });

		expect(response.status).toBe(304);
		expect(response.headers.get("Content-Security-Policy")).toBe(
			`script-src 'self' 'sha256-${sha256(THEME_SCRIPT)}', frame-ancestors 'none'`,
		);
	});

	it("trusts no inline script of an HTML file that the build recorded no hashes for", async () => {
		const { request } = await testServer({ plugins: [csp, prerendered()], clientDirectory });

		expect((await request("/new.html")).headers.get("Content-Security-Policy")).toBe(
			"script-src 'self'",
		);
	});

	it("gives the policy the request, so the policy can change by path", async () => {
		const { request } = await testServer({
			plugins: [
				contentSecurityPolicy({
					policy: ({ scriptSrc, context }) =>
						`script-src ${scriptSrc}; frame-ancestors ${context.req.path.startsWith("/preview/") ? "'self'" : "'none'"}`,
				}),
				prerendered(),
			],
			clientDirectory,
		});

		expect((await request("/about")).headers.get("Content-Security-Policy")).toMatch(
			/frame-ancestors 'none'$/u,
		);
		expect((await request("/preview/x")).headers.get("Content-Security-Policy")).toMatch(
			/^script-src 'nonce-[\w+/]{22}==' 'strict-dynamic'; frame-ancestors 'self'$/u,
		);
	});

	it("sets no CSP on a response that is not HTML", async () => {
		const { request } = await testServer({
			plugins: [csp],
			render: async () => Response.json({}),
		});

		expect((await request("/api")).headers.get("Content-Security-Policy")).toBeNull();
	});
});

describe("withHeaderHook", () => {
	it("rejects an async hook at type check", () => {
		const async: Plugin = {
			name: "async",
			middleware: async (context, next) =>
				// @ts-expect-error -- Why: an async hook would set its header after the head goes out.
				withHeaderHook(context, next, async (response) => {
					response.set("X-Async", "1");
				}),
		};
		expect(async.name).toBe("async");
	});
});
