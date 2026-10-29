/**
 * Disallows a fixed-time sleep in a test: a `new Promise` whose executor
 * passes its resolver to `setTimeout`. A sleep is a race, not a wait. From
 * mantle.
 *
 * @example
 * // ❌ Incorrect
 * await new Promise((resolve) => setTimeout(resolve, 100));
 *
 * // ✅ Correct
 * await vi.waitFor(() => expect(lines).toHaveLength(2));
 */

/** The name of a member property or a plain identifier, or `null` for a computed key. */
function propertyName(node) {
	if (node == null) {
		return null;
	}
	if (node.type === "Identifier") {
		return node.name;
	}
	if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
		return node.property.name;
	}
	return null;
}

/** Whether a timer callback is the promise resolver, or a function that calls it: `resolve` or `() => resolve()`. */
function isResolveCallback(callback, resolveName) {
	if (callback == null) {
		return false;
	}
	if (callback.type === "Identifier") {
		return callback.name === resolveName;
	}
	// Why the parameter check: a callback parameter with the resolver's name shadows the resolver.
	if (
		!callback.type.endsWith("FunctionExpression") ||
		callback.params.some((param) => param.type === "Identifier" && param.name === resolveName)
	) {
		return false;
	}
	const statements = callback.body.type === "BlockStatement" ? callback.body.body : [callback.body];
	return statements.some((statement) => {
		const expression = statement.type === "ExpressionStatement" ? statement.expression : statement;
		// Why a plain identifier: `deferred.resolve()` settles a different promise.
		return (
			expression.type === "CallExpression" &&
			expression.callee.type === "Identifier" &&
			expression.callee.name === resolveName
		);
	});
}

const noSleepInTests = {
	meta: {},
	create(context) {
		return {
			NewExpression(node) {
				if (node.callee.type !== "Identifier" || node.callee.name !== "Promise") {
					return;
				}
				const executor = node.arguments[0];
				if (executor == null || !executor.type.endsWith("FunctionExpression")) {
					return;
				}
				const resolve = executor.params[0];
				if (resolve?.type !== "Identifier") {
					return;
				}
				const body = executor.body.type === "BlockStatement" ? executor.body.body : [executor.body];
				const sleeps = body.some((statement) => {
					const expression =
						statement.type === "ExpressionStatement" ? statement.expression : statement;
					return (
						expression.type === "CallExpression" &&
						propertyName(expression.callee) === "setTimeout" &&
						isResolveCallback(expression.arguments[0], resolve.name)
					);
				});
				if (sleeps) {
					context.report({
						message:
							"A `setTimeout` sleep is a race, not a wait. Use `vi.waitFor` or `expect.poll` on the state you need.",
						node,
					});
				}
			},
		};
	},
};

const plugin = {
	meta: { name: "app-server" },
	rules: { "no-sleep-in-tests": noSleepInTests },
};

export default plugin;
