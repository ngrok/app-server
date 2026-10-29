/**
 * Requires a `-- <reason>` clause on every `oxlint-disable` directive, so a
 * reviewer can judge the suppression without a search. The reason names the
 * constraint that makes the rule wrong here.
 *
 * @example
 * // ❌ Incorrect
 * // oxlint-disable-next-line typescript/no-deprecated
 *
 * // ✅ Correct
 * // oxlint-disable-next-line typescript/no-deprecated -- Why: the `MediaQueryList` type still requires it.
 */

const DIRECTIVE = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?:\s+(?<rest>.*))?$/su;

const requireSuppressionReason = {
	meta: {},
	create(context) {
		return {
			Program() {
				for (const comment of context.sourceCode.getAllComments()) {
					const match = DIRECTIVE.exec(comment.value);
					if (match && !/--\s*\S/u.test(match.groups?.rest ?? "")) {
						context.report({
							message:
								"Add a `-- <reason>` clause that names the constraint that makes this rule wrong here. See AGENTS.md.",
							loc: comment.loc,
						});
					}
				}
			},
		};
	},
};

const rules = {
	"require-suppression-reason": requireSuppressionReason,
};

export default rules;
