/**
 * Disallows `context.var`. Read one variable with `context.get(name)`. The
 * rule has no types, so it checks `var` only on a receiver with a name that
 * Hono uses for its context: `context`, `c`, or `ctx`. A `record.var` stays
 * allowed.
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

const CONTEXT_NAMES = new Set(["context", "c", "ctx"]);

/** Whether `node` has a context name: as an identifier, or as the property of a member such as `this.context`. */
function isContextName(node) {
	if (node.type === "Identifier") {
		return CONTEXT_NAMES.has(node.name);
	}
	return (
		node.type === "MemberExpression" &&
		!node.computed &&
		node.property.type === "Identifier" &&
		CONTEXT_NAMES.has(node.property.name)
	);
}

const noContextVar = {
	meta: {},
	create(context) {
		return {
			MemberExpression(node) {
				if (
					!node.computed &&
					node.property.type === "Identifier" &&
					node.property.name === "var" &&
					isContextName(node.object)
				) {
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
