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

import { bodyExpressions, boundIdentifiers, isFunction } from "./ast.js";

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
		!isFunction(callback) ||
		callback.params.some((param) =>
			[...boundIdentifiers(param)].some((identifier) => identifier.name === resolveName),
		)
	) {
		return false;
	}
	// Why a plain identifier: `deferred.resolve()` settles a different promise.
	return bodyExpressions(callback).some(
		(expression) =>
			expression.type === "CallExpression" &&
			expression.callee.type === "Identifier" &&
			expression.callee.name === resolveName,
	);
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
				if (!isFunction(executor)) {
					return;
				}
				const resolve = executor.params[0];
				if (resolve?.type !== "Identifier") {
					return;
				}
				const sleeps = bodyExpressions(executor).some(
					(expression) =>
						expression.type === "CallExpression" &&
						propertyName(expression.callee) === "setTimeout" &&
						isResolveCallback(expression.arguments[0], resolve.name),
				);
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

const rules = { "no-sleep-in-tests": noSleepInTests };

export default rules;
