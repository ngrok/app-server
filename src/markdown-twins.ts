import { readdir } from "node:fs/promises";
import { sep } from "node:path";
import { parseAccept } from "hono/utils/accept";

/** How closely a media range matches `text/html`: 3 exact, 2 `text/*`, 1 any, 0 none. */
function htmlSpecificity(media: string): number {
	return ["*/*", "text/*", "text/html"].indexOf(media) + 1;
}

/**
 * Whether an `Accept` header prefers markdown to HTML. Markdown wins when it
 * names `text/markdown` with a quality above zero and at least that of HTML.
 * HTML takes the quality of its most specific range: `text/html`, then
 * `text/*`, then any type. A browser does not name markdown, so it gets HTML.
 *
 * @example
 * prefersMarkdown("text/markdown, text/html;q=0.9"); // => true
 * prefersMarkdown("text/html, text/markdown;q=0"); // => false
 * prefersMarkdown("text/html"); // => false
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
	if (accept == null || accept === "") {
		return false;
	}
	let markdown = 0;
	let html = { q: 0, specificity: 0 };
	for (const { type, q } of parseAccept(accept)) {
		const media = type.toLowerCase();
		const specificity = htmlSpecificity(media);
		if (media === "text/markdown") {
			markdown = Math.max(markdown, q);
		} else if (
			specificity > html.specificity ||
			(specificity === html.specificity && specificity > 0 && q > html.q)
		) {
			html = { q, specificity };
		}
	}
	return markdown > 0 && markdown >= html.q;
}

/**
 * Every `.md` file under `directory`, as URL paths that start with `/`.
 *
 * @example
 * await findMarkdownPaths("/app/build/client"); // => Set { "/index.md", "/components/button.md" }
 */
export async function findMarkdownPaths(directory: string): Promise<ReadonlySet<string>> {
	const files = await readdir(directory, { recursive: true, encoding: "utf8" });
	return new Set(
		files.filter((file) => file.endsWith(".md")).map((file) => `/${file.split(sep).join("/")}`),
	);
}

/**
 * The markdown file that answers a page path, or `undefined` when the build
 * has none. The root path maps to `/index.md`, and a trailing slash does not
 * change the result.
 *
 * @example
 * markdownTwinPath("/components/button/", new Set(["/components/button.md"])); // => "/components/button.md"
 * markdownTwinPath("/llms.txt", new Set(["/components/button.md"])); // => undefined
 */
export function markdownTwinPath(
	pathname: string,
	markdownPaths: ReadonlySet<string>,
): string | undefined {
	const trimmed = pathname.replace(/\/+$/, "");
	const twin = trimmed === "" ? "/index.md" : `${trimmed}.md`;
	return markdownPaths.has(twin) ? twin : undefined;
}
