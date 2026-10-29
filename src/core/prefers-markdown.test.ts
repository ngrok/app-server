import { describe, expect, it } from "vitest";
import { prefersMarkdown } from "./prefers-markdown.js";

function withAccept(accept?: string): Request {
	return new Request(
		"https://example.com/components/button",
		accept == null ? {} : { headers: { Accept: accept } },
	);
}

function selectsMarkdown(accept: string): boolean {
	return prefersMarkdown(withAccept(accept));
}

function selectsHtml(accept: string): boolean {
	return !selectsMarkdown(accept);
}

describe("prefersMarkdown", () => {
	it("selects markdown for an explicit text/markdown range", () => {
		const accepts = [
			"text/markdown",
			"Text/Markdown",
			"text/markdown;q=0.5",
			"text/markdown; charset=utf-8",
			"text/markdown, text/html;q=0.8",
			"text/markdown, text/plain;q=0.9, */*;q=0.8",
			"text/markdown;q=0.9, text/html;q=0.8, */*",
		];

		expect(accepts.filter((accept) => selectsHtml(accept))).toStrictEqual([]);
	});

	it("selects markdown when its q ties with HTML, because the client named it", () => {
		const accepts = ["text/html, text/markdown", "text/markdown, */*", "text/*, text/markdown"];

		expect(accepts.filter((accept) => selectsHtml(accept))).toStrictEqual([]);
	});

	it("selects HTML for a browser, a wildcard, and a request with no Accept", () => {
		const accepts = [
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
			"*/*",
			"text/*",
			"text/plain",
			"",
		];

		expect(accepts.filter((accept) => selectsMarkdown(accept))).toStrictEqual([]);
		expect(prefersMarkdown(withAccept())).toBe(false);
	});

	it("selects HTML when the client ranks HTML above markdown", () => {
		const accepts = [
			"text/html, text/markdown;q=0.5",
			"text/markdown;q=0.5, */*",
			"text/markdown;q=0.5, text/*",
		];

		expect(accepts.filter((accept) => selectsMarkdown(accept))).toStrictEqual([]);
	});

	it("uses the most specific range for the q of HTML", () => {
		expect(prefersMarkdown(withAccept("text/markdown;q=0.5, text/html;q=0.1, */*"))).toBe(true);
		expect(prefersMarkdown(withAccept("text/markdown;q=0.5, text/*;q=0.1, */*"))).toBe(true);
	});

	it("refuses markdown with q=0", () => {
		const accepts = ["text/markdown;q=0", "text/markdown; Q=0, text/html", "text/markdown;q=0.000"];

		expect(accepts.filter((accept) => selectsMarkdown(accept))).toStrictEqual([]);
	});

	it("reads a malformed q as 1, because the client still named markdown", () => {
		const accepts = [
			"text/markdown;q=, text/html",
			"text/markdown;q=abc, text/html",
			"text/markdown;q=0.5abc, text/html",
			"text/markdown;q=-1, text/html",
			"text/markdown;q=5, text/html",
			"text/markdown;q=0.0001, text/html",
		];

		expect(accepts.filter((accept) => selectsHtml(accept))).toStrictEqual([]);
	});

	it("reads a malformed q on HTML as 1", () => {
		expect(selectsMarkdown("text/markdown;q=0.9, text/html;q=x")).toBe(false);
	});

	it("reads a comma or a semicolon in a quoted parameter value as part of the value", () => {
		expect(selectsMarkdown(String.raw`text/html;foo="a,text/markdown,b"`)).toBe(false);
		expect(selectsMarkdown(String.raw`text/markdown;foo="a,b";q=0, text/html`)).toBe(false);
		expect(selectsMarkdown(String.raw`text/markdown;foo="a;q=0", text/html`)).toBe(true);
		expect(selectsMarkdown(String.raw`text/markdown;foo="a\",b";q=0, text/html`)).toBe(false);
	});

	it("uses the range with charset=utf-8 before the range with no charset", () => {
		const accepts = [
			"text/markdown, text/markdown;charset=utf-8;q=0, text/html;q=0.5",
			'text/markdown;q=0.9, text/markdown;charset="UTF-8";q=0.1, text/html;q=0.5',
			"text/markdown;q=0.5, text/html;q=0.1, text/html;charset=utf-8",
		];

		expect(accepts.filter((accept) => selectsMarkdown(accept))).toStrictEqual([]);
	});

	it("ignores a range with another charset, and other parameters", () => {
		expect(selectsMarkdown("text/markdown;charset=iso-8859-1")).toBe(false);
		expect(selectsMarkdown("text/markdown;charset=iso-8859-1, text/markdown;q=0.5")).toBe(true);
		expect(selectsMarkdown("text/markdown;q=0.5, text/html;charset=iso-8859-1")).toBe(true);
		expect(selectsMarkdown("text/markdown;variant=GFM")).toBe(true);
	});

	it("reads the Accept headers of one request as one list", () => {
		const headers = new Headers();
		headers.append("Accept", "text/html;q=0.5");
		headers.append("Accept", "text/markdown");

		expect(prefersMarkdown(new Request("https://example.com/", { headers }))).toBe(true);
	});
});
