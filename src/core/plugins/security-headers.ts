import type { Plugin } from "../types.js";

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
 * A response that has a header keeps its own value. The exception is
 * `Content-Security-Policy`, which has no default: the plugin adds a set
 * value as a second policy, and a browser enforces both.
 * `defaultPlugins()` puts it before the `beforeStatic` plugins, so it also
 * sees prerendered pages.
 *
 * @example
 * defaultPlugins({
 * 	securityHeaders: {
 * 		headers: {
 * 			"Cross-Origin-Opener-Policy": "same-origin-allow-popups",
 * 			"Content-Security-Policy": "frame-ancestors 'none'",
 * 		},
 * 	},
 * });
 */
export function securityHeaders({ headers = {} }: SecurityHeadersOptions = {}): Plugin {
	const values = Object.entries({ ...DEFAULT_SECURITY_HEADERS, ...headers }).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
	return {
		name: "security-headers",
		middleware: async (context, next) => {
			await next();
			const isHttps = new URL(context.req.url).protocol === "https:";
			for (const [name, value] of values) {
				if (name === "Content-Security-Policy") {
					context.header(name, value, { append: true });
				} else if (
					!context.res.headers.has(name) &&
					(name !== "Strict-Transport-Security" || isHttps)
				) {
					context.header(name, value);
				}
			}
		},
	};
}

/** Options for {@link cspNonce}. */
export type CspNonceOptions = {
	/** The `Content-Security-Policy` for a document, with the nonce of its request. */
	policy: (nonce: string) => string;
};

/** A new random nonce: 16 bytes in base64. */
function randomNonce(): string {
	return btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * Makes a random nonce for each request that reaches it, and sets the
 * `Content-Security-Policy` from `policy` on each HTML document. The app
 * reads the nonce from `requestContext()` and gives it to the framework's
 * render, so each inline script gets it.
 *
 * Put it after the static stages. A prerendered page has one nonce in its
 * file for every visitor, so it must use script hashes, not a nonce.
 * A response that has a `Content-Security-Policy` keeps it.
 *
 * @example
 * createServer({
 * 	plugins: [
 * 		...defaultPlugins(),
 * 		cspNonce({ policy: (nonce) => `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none'` }),
 * 	],
 * });
 */
export function cspNonce({ policy }: CspNonceOptions): Plugin {
	return {
		name: "csp-nonce",
		middleware: async (context, next) => {
			const nonce = randomNonce();
			context.set("cspNonce", nonce);
			await next();
			const { headers } = context.res;
			if (
				!headers.has("Content-Security-Policy") &&
				(headers.get("Content-Type")?.startsWith("text/html") ?? false)
			) {
				context.header("Content-Security-Policy", policy(nonce));
			}
		},
	};
}
