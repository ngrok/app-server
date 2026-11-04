/**
 * The CSP nonce of the document's first element with a nonce, or `undefined`
 * when it has none. The browser build of `@ngrok/app-server/client` exports it
 * as `cspNonce()`, so the browser bundle holds no server code.
 *
 * @example
 * documentNonce(); // => "d2hhdCBhIG5vbmNl"
 */
export function documentNonce(): string | undefined {
	// Why the property: a browser hides the value of the `nonce` attribute when the page's CSP applies.
	return document.querySelector<HTMLElement>("[nonce]")?.nonce;
}
