/** One media range of an `Accept` header. */
type MediaRange = {
	/** The media type in lowercase, such as `text/html` or `*\/*`. */
	type: string;
	/** The `q` value, from 0 to 1. */
	quality: number;
	/** The `charset` parameter in lowercase, when the range has one. */
	charset: string | undefined;
};

/** A `q` value as RFC 9110 writes it: 0 to 1, with up to three decimals. */
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u;

/** The charset of each answer that a caller of {@link prefersMarkdown} sends. */
// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- HTTP names the charset `utf-8`.
const CHARSET = "utf-8";

/**
 * The parts of `value` between each `separator`. Why a scan, not `split`: a
 * quoted parameter value can hold a `,` or a `;`.
 */
function splitOutsideQuotes(value: string, separator: string): string[] {
	const parts: string[] = [];
	let part = "";
	let quoted = false;
	let escaped = false;
	for (const character of value) {
		if (!quoted && character === separator) {
			parts.push(part);
			part = "";
		} else {
			if (escaped) {
				escaped = false;
			} else if (quoted && character === "\\") {
				escaped = true;
			} else if (character === '"') {
				quoted = !quoted;
			}
			part += character;
		}
	}
	parts.push(part);
	return parts;
}

/** The parameters of a media range, by lowercase name, with quotes removed. */
function parameterMap(parameters: readonly string[]): Map<string, string> {
	return new Map(
		parameters.map((parameter) => {
			const index = parameter.indexOf("=");
			const name = (index === -1 ? parameter : parameter.slice(0, index)).trim().toLowerCase();
			const value = index === -1 ? "" : parameter.slice(index + 1).trim();
			const unquoted = /^".*"$/su.test(value)
				? value.slice(1, -1).replaceAll(/\\(?<character>.)/gsu, "$<character>")
				: value;
			return [name, unquoted];
		}),
	);
}

/**
 * The media ranges of an `Accept` header. A missing `q` counts as 1, the RFC
 * 9110 default. Why a malformed `q` also counts as 1: the client still named
 * the media type.
 */
function mediaRanges(accept: string): MediaRange[] {
	return splitOutsideQuotes(accept, ",").map((entry) => {
		const [type = "", ...parameters] = splitOutsideQuotes(entry, ";");
		const parameterValues = parameterMap(parameters);
		const quality = parameterValues.get("q") ?? "1";
		return {
			type: type.trim().toLowerCase(),
			quality: QVALUE.test(quality) ? Number(quality) : 1,
			charset: parameterValues.get("charset")?.toLowerCase(),
		};
	});
}

/**
 * The `q` of an answer of `type` in UTF-8, from the most specific ranges with
 * that type, or `undefined` when no range matches it. A range with
 * `charset=utf-8` is more specific than a range with no charset. A range with
 * another charset does not match. Other parameters, such as `variant`, do not
 * change the match.
 */
function qualityOf(ranges: readonly MediaRange[], type: string): number | undefined {
	const matches = ranges.filter(
		(range) => range.type === type && (range.charset == null || range.charset === CHARSET),
	);
	const withCharset = matches.filter((range) => range.charset === CHARSET);
	const specific = withCharset.length > 0 ? withCharset : matches;
	return specific.length === 0 ? undefined : Math.max(...specific.map((range) => range.quality));
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
 * - Both answers are UTF-8. A range with `charset=utf-8` is more specific
 *   than a range with no charset, and a range with another charset does not
 *   match. Other parameters, such as `variant`, do not change the match.
 * - Media types and parameter names are not case-sensitive. A quoted
 *   parameter value can hold a `,` or a `;`.
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
