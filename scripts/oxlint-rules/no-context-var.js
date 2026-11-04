/**
 * Disallows `context.var`. Read one variable with `context.get(name)`.
 *
 * Why: Hono's `var` getter copies every variable of the request into a new
 * object on each read, and the pipeline reads variables on each request.
 *
 * @example
 * // ❌ Incorrect
 * context.var.logger.info("loading");
 *
 * // ✅ Correct
 * context.get("logger").info("loading");
 */
const noContextVar = {
	meta: {},
	create(context) {
		return {
			MemberExpression(node) {
				if (!node.computed && node.property.type === "Identifier" && node.property.name === "var") {
					context.report({
						message:
							"Read one variable with `context.get(name)`. Hono's `var` getter copies every variable on each read.",
						node,
					});
				}
			},
		};
	},
};

const rules = { "no-context-var": noContextVar };

export default rules;
