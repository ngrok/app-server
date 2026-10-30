import { describe, expect, it } from "vitest";
import { testServer } from "../../test-server.js";
import { defaultPlugins } from "../create-server.js";
import { withHeaderHook } from "../header-hook.js";
import type { Plugin } from "../types.js";
import { cspNonce, securityHeaders } from "./security-headers.js";

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
		];
		expect(Object.fromEntries(names.map((name) => [name, http.headers.get(name)]))).toStrictEqual({
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "strict-origin-when-cross-origin",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Content-Security-Policy": null,
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

describe("cspNonce", () => {
	it("gives each request a new nonce, and the CSP has the nonce that the render used", async () => {
		const { request } = await testServer({
			plugins: [cspNonce({ policy: (nonce) => `script-src 'nonce-${nonce}'` })],
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
		expect(first.headers.get("Content-Security-Policy")).toBe(`script-src 'nonce-${firstNonce}'`);
	});

	it("sets no CSP on a response that is not HTML", async () => {
		const { request } = await testServer({
			plugins: [cspNonce({ policy: (nonce) => `script-src 'nonce-${nonce}'` })],
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
