/**
 * Test rules that a reviewer otherwise catches by hand, from mantle.
 * `.oxlintrc.json` scopes them to test files.
 *
 * `no-only-to-be-defined`: a test whose only assertion is `toBeDefined()`
 * passes on a wrong value. Assert the value.
 *
 * `no-config-teardown`: `vitest.config.ts` sets `restoreMocks`, `unstubEnvs`,
 * and `unstubGlobals`, so a hook that tears them down again is dead code.
 *
 * @example
 * // ❌ Incorrect
 * it("loads", () => { expect(result).toBeDefined(); });
 * afterEach(() => { vi.restoreAllMocks(); });
 */

import { bodyExpressions, isFunction } from "./ast.js";

const TEST_FUNCTION_NAMES = new Set(["it", "test"]);

/** The name at the root of a callee: `it` for `it(…)`, `it.concurrent(…)`, `it.each([…])(…)`, and ``it.each`…`(…)``. */
function rootName(callee) {
	let current = callee;
	for (;;) {
		if (current.type === "MemberExpression") {
			current = current.object;
		} else if (current.type === "CallExpression") {
			current = current.callee;
		} else if (current.type === "TaggedTemplateExpression") {
			current = current.tag;
		} else {
			break;
		}
	}
	return current.type === "Identifier" ? current.name : null;
}

/** Whether the call chain under a matcher call starts at `expect(…)` or `expect.<modifier>(…)`. */
function isExpectChain(node) {
	// Why not a bare `expect`: `expect.objectContaining(…)` builds a matcher, not an assertion.
	return node.type !== "Identifier" && rootName(node) === "expect";
}

/** Collects the matcher names called on `expect` chains in a subtree, with a `not.` prefix when negated. */
function collectMatchers(node, matchers) {
	if (node == null || typeof node !== "object") {
		return;
	}
	if (
		node.type === "CallExpression" &&
		node.callee.type === "MemberExpression" &&
		node.callee.property.type === "Identifier" &&
		isExpectChain(node.callee.object)
	) {
		const { object, property } = node.callee;
		// Why keep the negation: `not.toBeDefined()` asserts the exact value `undefined`.
		const negated =
			object.type === "MemberExpression" &&
			object.property.type === "Identifier" &&
			object.property.name === "not";
		matchers.push(negated ? `not.${property.name}` : property.name);
	}
	// Why skip `parent`: the walk would climb back up the tree.
	for (const [, child] of Object.entries(node).filter(([name]) => name !== "parent")) {
		if (Array.isArray(child)) {
			for (const item of child) {
				collectMatchers(item, matchers);
			}
		} else {
			collectMatchers(child, matchers);
		}
	}
}

const noOnlyToBeDefined = {
	meta: {},
	create(context) {
		return {
			CallExpression(node) {
				if (!TEST_FUNCTION_NAMES.has(rootName(node.callee))) {
					return;
				}
				const body = node.arguments.find((argument) => isFunction(argument));
				if (body == null) {
					return;
				}
				const matchers = [];
				collectMatchers(body.body, matchers);
				if (matchers.length > 0 && matchers.every((matcher) => matcher === "toBeDefined")) {
					context.report({
						message:
							"`toBeDefined()` is this test's only assertion, so a wrong value passes. Assert the value.",
						node: node.callee,
					});
				}
			},
		};
	},
};

const HOOK_NAMES = new Set(["afterEach", "beforeEach"]);
const CONFIG_TEARDOWN = new Set([
	"clearAllMocks",
	"restoreAllMocks",
	"unstubAllEnvs",
	"unstubAllGlobals",
]);

/** Whether the call is `vi.<teardown>()`. */
function isConfigTeardown(call) {
	const { callee } = call;
	return (
		callee.type === "MemberExpression" &&
		callee.object.type === "Identifier" &&
		callee.object.name === "vi" &&
		callee.property.type === "Identifier" &&
		CONFIG_TEARDOWN.has(callee.property.name)
	);
}

const noConfigTeardown = {
	meta: {},
	create(context) {
		return {
			CallExpression(node) {
				const callback = node.arguments[0];
				if (
					node.callee.type !== "Identifier" ||
					!HOOK_NAMES.has(node.callee.name) ||
					!isFunction(callback)
				) {
					return;
				}
				for (const expression of bodyExpressions(callback)) {
					if (expression.type === "CallExpression" && isConfigTeardown(expression)) {
						context.report({
							message: "The Vitest config already runs this teardown; delete it.",
							node: expression,
						});
					}
				}
			},
		};
	},
};

const rules = {
	"no-config-teardown": noConfigTeardown,
	"no-only-to-be-defined": noOnlyToBeDefined,
};

export default rules;
