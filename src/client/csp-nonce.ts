import { requestContext } from "../core/request-context.js";

/**
 * The CSP nonce of the document, for the framework's render. It gives the
 * same value on the server and in the browser, so the hydration matches.
 *
 * - On the server, the nonce of the request that runs, from `requestContext()`.
 * - In the browser, the nonce of the document's first element with a nonce.
 *   Why: React Router's `<HydratedRouter>` takes no nonce, so the app reads it
 *   from the document.
 *
 * It gives `undefined` when the page has no nonce: with no
 * `contentSecurityPolicy` plugin, during a prerender, and on a prerendered page.
 *
 * @example
 * <Scripts nonce={cspNonce()} />
 */
export function cspNonce(): string | undefined {
	if (typeof document === "undefined") {
		return requestContext()?.cspNonce;
	}
	// Why the property: a browser hides the value of the `nonce` attribute when the page's CSP applies.
	return document.querySelector<HTMLElement>("[nonce]")?.nonce;
}
