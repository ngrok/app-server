/** One media range of an `Accept` header. */
type MediaRange = {
	/** The media type in lowercase, such as `text/html` or `*\/*`. */
	type: string;
	/** The `q` value, from 0 to 1. */
	quality: number;
};

/** A `q` value as RFC 9110 writes it: 0 to 1, with up to three decimals. */
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u;

/**
 * The media ranges of an `Accept` header. A missing `q` counts as 1, the RFC
 * 9110 default. Why a malformed `q` also counts as 1: the client still named
 * the media type.
 */
function mediaRanges(accept: string): MediaRange[] {
	return accept.split(",").map((entry) => {
		const [type = "", ...parameters] = entry.split(";");
		const qualityParameter = parameters
			.map((parameter) => parameter.trim().toLowerCase())
			.find((parameter) => parameter.startsWith("q="));
		const value = qualityParameter?.slice("q=".length) ?? "1";
		return {
			type: type.trim().toLowerCase(),
			quality: QVALUE.test(value) ? Number(value) : 1,
		};
	});
}

/** The highest `q` of the ranges with `type`, or `undefined` when no range has it. */
function qualityOf(ranges: readonly MediaRange[], type: string): number | undefined {
	const qualities = ranges.filter((range) => range.type === type).map((range) => range.quality);
	return qualities.length === 0 ? undefined : Math.max(...qualities);
}

/**
 * Whether a request asks for markdown before HTML, per
 * https://acceptmarkdown.com. Use it to choose between the HTML and the
 * markdown answer for one URL.
 *
 * The rules:
 *
 * - Only an explicit `text/markdown` range counts for markdown. A wildcard,
 *   such as `*\/*` or `text/*`, never selects markdown, so a browser and a
 *   client with no `Accept` get HTML.
 * - `text/markdown;q=0` refuses markdown.
 * - The `q` of markdown must be equal to or higher than the `q` of HTML. The
 *   `q` of HTML comes from the most specific range that matches it:
 *   `text/html`, then `text/*`, then `*\/*`. A tie selects markdown, because
 *   the client named it.
 * - Media types and parameter names are not case-sensitive.
 *
 * When the answer for a URL depends on this function, send `Vary: Accept` on
 * both the HTML and the markdown answer. Else a shared cache can give the
 * markdown to a browser.
 *
 * @example
 * prefersMarkdown(new Request("https://example.com/", { headers: { Accept: "text/markdown" } }));
 * // => true
 * prefersMarkdown(new Request("https://example.com/", { headers: { Accept: "text/html, text/markdown;q=0.5" } }));
 * // => false
 */
export function prefersMarkdown(request: Request): boolean {
	const accept = request.headers.get("Accept");
	if (accept == null) {
		return false;
	}
	const ranges = mediaRanges(accept);
	const markdown = qualityOf(ranges, "text/markdown") ?? 0;
	const html =
		qualityOf(ranges, "text/html") ?? qualityOf(ranges, "text/*") ?? qualityOf(ranges, "*/*") ?? 0;
	return markdown > 0 && markdown >= html;
}
