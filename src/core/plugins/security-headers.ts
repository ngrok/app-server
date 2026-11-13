import type { Context } from "hono";
import { withHeaderHook } from "../header-hook.js";
import { optionPlugin } from "../plugin-options.js";
import type { AppServerEnv, Plugin } from "../types.js";

/** The headers that {@link securityHeaders} sets, by name. */
export type SecurityHeaderValues = {
	"X-Content-Type-Options"?: string | false;
	"Referrer-Policy"?: string | false;
	"Cross-Origin-Opener-Policy"?: string | false;
	/** Sent on an HTTPS request only. */
	"Strict-Transport-Security"?: string | false;
	/**
	 * A policy that the plugin adds to each response, next to the app's own
	 * policy. It has no default.
	 */
	"Content-Security-Policy"?: string | false;
	/**
	 * The browser features that the page and its frames can use, such as
	 * `camera=(), microphone=(), geolocation=()`. It has no default.
	 */
	"Permissions-Policy"?: string | false;
};

// Why no `includeSubDomains`: a browser keeps HSTS for a year, and on an apex domain it would force
// HTTPS on each subdomain. An app adds it when it knows each subdomain serves HTTPS.
const DEFAULT_SECURITY_HEADERS: SecurityHeaderValues = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Strict-Transport-Security": "max-age=31536000",
};

/** Options for {@link securityHeaders}. */
export type SecurityHeadersOptions = {
	/** Values that replace the defaults. `false` turns a header off. */
	headers?: SecurityHeaderValues;
};

/**
 * Sets safe default security headers on each response:
 *
 * - `X-Content-Type-Options: nosniff`
 * - `Referrer-Policy: strict-origin-when-cross-origin`
 * - `Cross-Origin-Opener-Policy: same-origin`
 * - `Strict-Transport-Security: max-age=31536000`, on an HTTPS request only
 *
 * `Content-Security-Policy` and `Permissions-Policy` have no default. A
 * response that has a header keeps its own value. The exception is
 * `Content-Security-Policy`: the plugin adds a set value as a second policy,
 * and a browser enforces both.
 * `defaultPlugins()` puts it before the static stages, so it also sees
 * prerendered pages.
 *
 * @example
 * defaultPlugins({
 * 	securityHeaders: {
 * 		headers: {
 * 			"Cross-Origin-Opener-Policy": "same-origin-allow-popups",
 * 			"Content-Security-Policy": "frame-ancestors 'none'",
 * 			"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
 * 		},
 * 	},
 * });
 */
export function securityHeaders({ headers = {} }: SecurityHeadersOptions = {}): Plugin {
	const values = Object.entries({ ...DEFAULT_SECURITY_HEADERS, ...headers })
		.filter((entry): entry is [string, string] => typeof entry[1] === "string")
		.map(([name, value]) => [name, oneLine(value)] as const);
	return {
		name: "security-headers",
		// oxlint-disable-next-line typescript/promise-function-async -- the server awaits each stage in a `try`, and an `async` stage adds a promise to each request.
		middleware: (context, next) => {
			const isHttps = context.req.url.startsWith("https:");
			return withHeaderHook(context, next, (response) => {
				for (const [name, value] of values) {
					if (name === "Content-Security-Policy") {
						response.append(name, value);
					} else if (!response.has(name) && (name !== "Strict-Transport-Security" || isHttps)) {
						response.set(name, value);
					}
				}
			});
		},
	};
}

/**
 * `value` on one line. Why: a header value cannot hold a line break, and a
 * policy written over several lines treats each run of whitespace as one space.
 */
function oneLine(value: string): string {
	return value.replaceAll(/\s+/gu, " ").trim();
}

/** Options for {@link contentSecurityPolicy}. */
export type ContentSecurityPolicyOptions = {
	/**
	 * The `Content-Security-Policy` of an HTML document. `scriptSrc` is the
	 * source list that trusts the document's scripts. Put it in `script-src`.
	 * `context` is the request, so the policy can change by path. It runs in a
	 * header hook, so it can run more than once for one request.
	 */
	policy: (document: { scriptSrc: string; context: Context<AppServerEnv> }) => string;
};

/** A new random nonce: 16 bytes in base64. */
function randomNonce(): string {
	return btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * Sets the `Content-Security-Policy` from `policy` on each HTML document. The
 * policy trusts the document's scripts, and only them:
 *
 * - A rendered document gets `'nonce-…' 'strict-dynamic'` with a new nonce
 *   for each request. The app gives `cspNonce()` from
 *   `@ngrok/app-server/client` to the framework's render, so each inline
 *   script gets the nonce.
 * - A prerendered document gets `'self'` and the hash of each of its inline
 *   scripts, which the Vite plugin records. Its file has one nonce for every
 *   visitor, so a nonce protects nothing. Why no `'strict-dynamic'`: a hash,
 *   unlike a nonce, does not carry to the imports of an inline module script.
 *
 * The `contentSecurityPolicy` option of `defaultPlugins()` takes these
 * options, and puts the plugin before the static stages, so it sees the
 * prerendered documents. A response that has a `Content-Security-Policy`
 * keeps it.
 *
 * @example
 * defaultPlugins({
 * 	contentSecurityPolicy: {
 * 		policy: ({ scriptSrc }) => `script-src ${scriptSrc}; object-src 'none'; base-uri 'none'`,
 * 	},
 * });
 */
export function contentSecurityPolicy({ policy }: ContentSecurityPolicyOptions): Plugin {
	let scriptHashes: ReadonlyMap<string, readonly string[]> = new Map();
	return optionPlugin("contentSecurityPolicy", {
		name: "content-security-policy",
		setup: (info) => {
			({ scriptHashes } = info);
		},
		// oxlint-disable-next-line typescript/promise-function-async -- the server awaits each stage in a `try`, and an `async` stage adds a promise to each request.
		middleware: (context, next) => {
			const nonce = randomNonce();
			context.set("cspNonce", nonce);
			// Why a header hook: in development, the dev server sends its own response, such as a file of
			// Vite's public directory, and runs the hooks before it sends the head.
			return withHeaderHook(context, next, (headers) => {
				// Why `staticDocument` too: a 304 has no `Content-Type`, and a browser replaces the cached policy with its policy.
				const file = context.get("staticDocument");
				const hashes =
					context.get("documentScriptHashes") ??
					(file == null ? undefined : (scriptHashes.get(file) ?? []));
				if (
					headers.has("Content-Security-Policy") ||
					(hashes == null && !(headers.get("Content-Type")?.startsWith("text/html") ?? false))
				) {
					return;
				}
				// Why `'self'` only for a file with no hashes: the policy fails closed, so a missed script shows in a test.
				const scriptSrc =
					hashes == null
						? `'nonce-${nonce}' 'strict-dynamic'`
						: ["'self'", ...hashes.map((hash) => `'sha256-${hash}'`)].join(" ");
				headers.set("Content-Security-Policy", oneLine(policy({ scriptSrc, context })));
			});
		},
	});
}
