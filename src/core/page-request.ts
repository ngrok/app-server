import { mediaRanges, qualityOf } from "./prefers-markdown.js";

/**
 * Whether a request asks for a page: a `GET` or a `HEAD` that does not
 * accept `text/event-stream`.
 *
 * The rules:
 *
 * - Each other method, such as `POST` or `OPTIONS`, is not a page request.
 * - Only an explicit `text/event-stream` range with a `q` more than 0 makes a
 *   `GET` a protocol request. A wildcard, such as `*\/*`, does not, so a
 *   browser gets the page.
 *
 * @example
 * isPageRequest(new Request("https://example.com/mcp")); // => true
 * isPageRequest(new Request("https://example.com/mcp", { headers: { Accept: "text/event-stream" } })); // => false
 * isPageRequest(new Request("https://example.com/mcp", { method: "POST" })); // => false
 */
export function isPageRequest(request: Request): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return false;
	}
	const accept = request.headers.get("Accept");
	// Why the substring check: a browser never names an event stream, and it skips the parse of its long `Accept`.
	if (accept == null || !/event-stream/iu.test(accept)) {
		return true;
	}
	return (qualityOf(mediaRanges(accept), "text/event-stream") ?? 0) === 0;
}
