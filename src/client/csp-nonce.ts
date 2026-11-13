import { requestContext } from "../core/request-context.js";
import { documentNonce } from "./document-nonce.js";

/**
 * The CSP nonce of the document, for the framework's render. It gives the
 * same value on the server and in the browser, so the hydration matches.
 *
 * - In a server request, the nonce of the request, from `requestContext()`.
 *   Why the request first: a test environment, such as jsdom, and a DOM
 *   polyfill give the server a `document`.
 * - In the browser, the nonce of the document's first element with a nonce.
 *   Why: React Router's `<HydratedRouter>` takes no nonce, so the app reads it
 *   from the document.
 *
 * It gives `undefined` when the page has no nonce: with no
 * `contentSecurityPolicy` plugin, during a prerender, and on a prerendered page.
 * A bundler that resolves the `browser` condition, such as Vite for the
 * client, gets a build with no server code.
 *
 * @example
 * <Scripts nonce={cspNonce()} />
 */
export function cspNonce(): string | undefined {
	return (
		requestContext()?.cspNonce ?? (typeof document === "undefined" ? undefined : documentNonce())
	);
}
