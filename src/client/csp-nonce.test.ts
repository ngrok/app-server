import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { contentSecurityPolicy } from "../core/plugins/security-headers.js";
import { host } from "../node/index.js";
import { testServer } from "../test-server.js";
import { cspNonce } from "./csp-nonce.js";

/** A server whose framework renders a page with the nonce of `cspNonce()`. */
async function server() {
	const { request, internals } = await testServer({
		plugins: [contentSecurityPolicy({ policy: (scriptSrc) => `script-src ${scriptSrc}` })],
		render: async () =>
			new Response(`<!doctype html><script nonce="${cspNonce() ?? ""}"></script>`, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			}),
	});
	internals.setRequestStore(host.storage);
	return request;
}

/**
 * A browser document of `html`. Why the stand-in: happy-dom has no `nonce`
 * property, and a browser hides the value of the `nonce` attribute.
 */
function browserDocument(html: string) {
	const { document } = new Window();
	document.write(html);
	for (const element of document.querySelectorAll("[nonce]")) {
		const nonce = element.getAttribute("nonce");
		element.setAttribute("nonce", "");
		Object.defineProperty(element, "nonce", { value: nonce });
	}
	return document;
}

describe("cspNonce", () => {
	it("gives the same nonce on the server and in the browser, so the hydration matches", async () => {
		const request = await server();

		const response = await request("/");
		const html = await response.text();
		vi.stubGlobal("document", browserDocument(html));

		const nonce = cspNonce();
		expect(nonce).toMatch(/^[\w+/]+=*$/u);
		expect(html).toContain(`nonce="${nonce}"`);
		expect(response.headers.get("Content-Security-Policy")).toBe(
			`script-src 'nonce-${nonce}' 'strict-dynamic'`,
		);
	});

	it("gives undefined outside a request and in a document with no nonce", () => {
		expect(cspNonce()).toBeUndefined();

		vi.stubGlobal("document", browserDocument("<!doctype html><script></script>"));

		expect(cspNonce()).toBeUndefined();
	});
});
