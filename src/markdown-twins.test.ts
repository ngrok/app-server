import { describe, expect, it } from "vitest";
import { markdownTwinPath, prefersMarkdown } from "./markdown-twins.js";

describe("prefersMarkdown", () => {
	it.each([
		["text/markdown", true],
		["text/markdown, text/html;q=0.9", true],
		["text/html, text/markdown", true],
		["text/html, text/markdown;q=0", false],
		["text/markdown;q=0.5, text/html", false],
		["text/markdown;q=0.5, */*;q=0.8", false],
		["text/markdown;q=0.9, text/html;q=0, */*;q=1", true],
		["text/markdown;q=0.5, text/*;q=0.8, */*;q=0.1", false],
		["text/markdown, application/json", true],
		["text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", false],
		["", false],
		[undefined, false],
	])("answers %j with %s", (accept, expected) => {
		expect(prefersMarkdown(accept)).toBe(expected);
	});
});

describe("markdownTwinPath", () => {
	const markdownPaths = new Set(["/index.md", "/components/actions/button.md"]);

	it("maps a page path, with or without a trailing slash, to its markdown file", () => {
		expect(markdownTwinPath("/components/actions/button", markdownPaths)).toBe(
			"/components/actions/button.md",
		);
		expect(markdownTwinPath("/components/actions/button/", markdownPaths)).toBe(
			"/components/actions/button.md",
		);
	});

	it("maps the root path to the index page", () => {
		expect(markdownTwinPath("/", markdownPaths)).toBe("/index.md");
	});

	it("returns undefined for a path with no markdown file", () => {
		expect(markdownTwinPath("/llms.txt", markdownPaths)).toBeUndefined();
	});
});
