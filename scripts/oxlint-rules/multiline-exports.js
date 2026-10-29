/**
 * Enforces that named exports with multiple specifiers are written in multi-line
 * format with a `//,` marker comment, but only when the single-line form would
 * fit within the `printWidth` in .oxfmtrc.json.
 *
 * oxfmt collapses export specifier lists to a single line regardless of
 * `objectWrap: preserve`, because export specifiers are not object literals.
 * Adding `//,` as the first item in the specifier list prevents that collapse.
 * For exports that already exceed printWidth, the formatter won't reasonably
 * collapse them, so the marker is not required.
 *
 * @example
 * // ✅ Correct
 * export {
 *   //,
 *   foo,
 *   bar,
 * } from "./foo.js";
 *
 * // ✅ Also fine — exceeds printWidth, so the formatter expands it to multi-line naturally;
 * // the //,  marker is not needed because the formatter won't collapse it back.
 * // The result after formatting:
 * export {
 *   reallyLongExportNameA,
 *   reallyLongExportNameB,
 *   reallyLongExportNameC,
 * } from "./foo.js";
 *
 * // ❌ Incorrect — fits on one line so formatter will collapse it; add the marker
 * export { foo, bar } from "./foo.js";
 */

import { readFileSync } from "node:fs";

// Why read the config: the rule must agree with the width that oxfmt formats to.
const { printWidth: PRINT_WIDTH } = JSON.parse(
	readFileSync(new URL("../../.oxfmtrc.json", import.meta.url), "utf8"),
);
// Why 2: it is oxfmt's default `tabWidth`, and .oxfmtrc.json does not set it.
const TAB_WIDTH = 2;

const multilineExports = {
	meta: {
		fixable: "code",
	},
	create(context) {
		return {
			ExportNamedDeclaration(node) {
				if (node.specifiers.length < 2) {
					return;
				}

				const sourceCode = context.sourceCode;

				// Find the opening { of the specifier list
				const firstSpec = node.specifiers[0];
				const openBrace = sourceCode.getTokenBefore(firstSpec);
				if (!openBrace || openBrace.value !== "{") {
					return;
				}

				// Find the closing } of the specifier list, skipping a trailing comma
				const lastSpec = node.specifiers.at(-1);
				let closeBrace = sourceCode.getTokenAfter(lastSpec);
				if (closeBrace?.value === ",") {
					closeBrace = sourceCode.getTokenAfter(closeBrace);
				}
				if (!closeBrace || closeBrace.value !== "}") {
					return;
				}

				// Why any line comment: oxfmt cannot collapse a list that holds one, and `//,` is one.
				const insideBraces = sourceCode
					.getAllComments()
					.filter(
						(comment) =>
							comment.range[0] > openBrace.range[0] && comment.range[1] < closeBrace.range[1],
					);
				if (insideBraces.some((comment) => comment.type === "Line")) {
					return;
				}

				// Skip enforcement when the single-line form exceeds printWidth — the
				// formatter won't reasonably collapse those, so the //, marker isn't needed.
				const exportLine = sourceCode.lines[node.loc.start.line - 1];
				const baseIndent = /^(?<indent>\s*)/u.exec(exportLine)?.groups?.indent ?? "";
				const indentVisualWidth = baseIndent.replaceAll("\t", " ".repeat(TAB_WIDTH)).length;
				const exportKindPrefix = node.exportKind === "type" ? "type " : "";
				// Why source text: an exported name can be a string literal, which has no `name`.
				const specTexts = node.specifiers.map((spec) => sourceCode.getText(spec));
				const fromClause = node.source ? ` from "${node.source.value}"` : "";
				const singleLineWidth =
					indentVisualWidth +
					`export ${exportKindPrefix}{ ${specTexts.join(", ")} }${fromClause};`.length;
				if (singleLineWidth > PRINT_WIDTH) {
					return;
				}

				const message =
					'Named exports with multiple specifiers must use multi-line format with a "//," marker to prevent formatter collapse.';
				// Why no fix: the fix rebuilds the list from its specifiers, so it would drop a comment.
				if (insideBraces.length > 0) {
					context.report({ message, node });
					return;
				}
				context.report({
					message,
					node,
					fix(fixer) {
						const specIndent = `${baseIndent}\t`;

						const specLines = specTexts.map((text) => `${specIndent}${text},`);

						const expanded = `{\n${specIndent}//,\n${specLines.join("\n")}\n${baseIndent}}`;

						return fixer.replaceTextRange([openBrace.range[0], closeBrace.range[1]], expanded);
					},
				});
			},
		};
	},
};

const rules = {
	"multiline-exports": multilineExports,
};

export default rules;
