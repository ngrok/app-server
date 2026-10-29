/**
 * Disallows `=== undefined` and `!== undefined`. Write `== null` or
 * `!= null`, which covers `null` and `undefined` together. When `undefined`
 * and `null` mean different things, suppress the rule and give the reason.
 * `eqeqeq` with `{ "null": "never" }` already rejects `=== null` and
 * `== undefined`, so the three rules leave one way to check for no value.
 *
 * A `typeof x === "undefined"` check stays allowed: it is the only safe check
 * for a global that a runtime does not declare, such as `Bun`.
 *
 * @example
 * // ❌ Incorrect
 * if (value === undefined) {}
 *
 * // ✅ Correct
 * if (value == null) {}
 */

/** Whether a node is the identifier `undefined`. */
function isUndefined(node) {
	return node.type === "Identifier" && node.name === "undefined";
}

const preferNullCheck = {
	meta: {},
	create(context) {
		return {
			BinaryExpression(node) {
				if (node.operator !== "===" && node.operator !== "!==") {
					return;
				}
				if (isUndefined(node.left) || isUndefined(node.right)) {
					const loose = node.operator === "===" ? "==" : "!=";
					context.report({
						message: `Write \`${loose} null\`, which also covers \`null\`. Suppress the rule with a reason when \`undefined\` and \`null\` mean different things.`,
						node,
					});
				}
			},
		};
	},
};

const rules = { "prefer-null-check": preferNullCheck };

export default rules;
