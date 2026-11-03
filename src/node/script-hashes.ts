import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { contentType } from "../core/static-files.js";

/**
 * An HTML comment, or a `<script>` element. The `attributes` group is the
 * script's attributes, and the `text` group is its text. Why the comment: a
 * `<script>` tag in a comment starts no element.
 */
const COMMENT_OR_SCRIPT =
	/<!--[\s\S]*?-->|<script(?=[\s/>])(?<attributes>(?:[^>"']|"[^"]*"|'[^']*')*)>(?<text>[\s\S]*?)<\/script(?=[\s/>])/giu;

/** An attribute value, so that a `src=` in a value is not the `src` attribute. */
const ATTRIBUTE_VALUE = /[=]\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gu;

/** A `src` attribute, in attributes with no values. */
const SRC_ATTRIBUTE = /(?:^|[\s/])src(?:[\s/=]|$)/iu;

/**
 * The base64 `SHA-256` of each inline script in `html`, once each, in
 * document order. Why each type: a hash of a data block, such as JSON, trusts
 * no code, and a scan that skips a type that runs breaks the page. Why LF:
 * the browser changes each CRLF and CR to LF before it hashes a script.
 *
 * @example
 * inlineScriptHashes("<script>go()</script>"); // => ["…base64…"]
 */
export function inlineScriptHashes(html: string): string[] {
	const hashes: string[] = [];
	for (const { groups } of html.replaceAll(/\r\n?/gu, "\n").matchAll(COMMENT_OR_SCRIPT)) {
		if (
			groups?.text != null &&
			!SRC_ATTRIBUTE.test((groups.attributes ?? "").replaceAll(ATTRIBUTE_VALUE, "="))
		) {
			hashes.push(createHash("sha256").update(groups.text).digest("base64"));
		}
	}
	return [...new Set(hashes)];
}

/**
 * The {@link inlineScriptHashes} of the HTML file at the URL `path` in
 * `directory`, such as Vite's public directory, or `undefined` when it has no
 * such file. Why it reads the file for each call: a developer can edit it at
 * any time, and only a request for an HTML file reads it.
 *
 * @example
 * publicScriptHashes("/app/public", "/offline.html"); // => ["…base64…"]
 */
export function publicScriptHashes(directory: string, path: string): string[] | undefined {
	if (directory === "" || !contentType(path, {}).startsWith("text/html")) {
		return undefined;
	}
	let file: string;
	try {
		file = resolve(directory, `.${decodeURIComponent(path)}`);
	} catch {
		return undefined;
	}
	// Why: a path such as `/../secret.html` must not leave the directory.
	if (
		!file.startsWith(`${resolve(directory)}${sep}`) ||
		statSync(file, { throwIfNoEntry: false })?.isFile() !== true
	) {
		return undefined;
	}
	return inlineScriptHashes(readFileSync(file, "utf8"));
}
