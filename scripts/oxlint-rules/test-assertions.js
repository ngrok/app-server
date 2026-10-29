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

const TEST_FUNCTION_NAMES = new Set(["it", "test"]);
/** Whether the call chain under a matcher call starts at `expect(…)` or `expect.element(…)`. */
function isExpectChain(node) {
	let current = node;
	while (current != null) {
		if (current.type === "CallExpression") {
			const callee = current.callee;
			if (callee.type === "Identifier" && callee.name === "expect") {
				return true;
			}
			if (
				callee.type === "MemberExpression" &&
				callee.object.type === "Identifier" &&
				callee.object.name === "expect"
			) {
				return true;
			}
			current = callee.type === "MemberExpression" ? callee.object : null;
		} else if (current.type === "MemberExpression") {
			current = current.object;
		} else {
			return false;
		}
	}
	return false;
}

/** Collects the matcher names called on `expect` chains in a subtree. */
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
		matchers.push(node.callee.property.name);
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
				if (node.callee.type !== "Identifier" || !TEST_FUNCTION_NAMES.has(node.callee.name)) {
					return;
				}
				const body = node.arguments.find(
					(argument) =>
						argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression",
				);
				if (body == null) {
					return;
				}
				const matchers = [];
				collectMatchers(body.body, matchers);
				if (matchers.length > 0 && matchers.every((matcher) => matcher === "toBeDefined")) {
					context.report({
						message:
							"`toBeDefined()` is this test's only assertion, so a wrong value passes. Assert the value, DOM state, or ARIA state.",
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

const CLEANUP_SOURCES = new Set(["@testing-library/react", "vitest-browser-react"]);

/** Whether the call is `vi.<teardown>()` or a `cleanup()` imported from a testing library. */
function isConfigTeardown(call, cleanupNames) {
	const { callee } = call;
	if (callee.type === "Identifier") {
		return cleanupNames.has(callee.name);
	}
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
		const cleanupNames = new Set();
		return {
			ImportDeclaration(node) {
				if (!CLEANUP_SOURCES.has(node.source.value)) {
					return;
				}
				for (const specifier of node.specifiers) {
					if (
						specifier.type === "ImportSpecifier" &&
						specifier.imported.type === "Identifier" &&
						specifier.imported.name === "cleanup"
					) {
						cleanupNames.add(specifier.local.name);
					}
				}
			},
			CallExpression(node) {
				const callback = node.arguments[0];
				if (node.callee.type !== "Identifier" || !HOOK_NAMES.has(node.callee.name)) {
					return;
				}
				// `afterEach(cleanup)` passes the teardown itself.
				if (callback?.type === "Identifier" && cleanupNames.has(callback.name)) {
					context.report({
						message: "The Vitest config and setup file already run this teardown; delete it.",
						node: callback,
					});
					return;
				}
				if (
					callback?.type !== "ArrowFunctionExpression" &&
					callback?.type !== "FunctionExpression"
				) {
					return;
				}
				// A concise arrow body is one expression, not a statement list.
				const expressions =
					callback.body.type === "BlockStatement"
						? callback.body.body
								.filter((statement) => statement.type === "ExpressionStatement")
								.map((statement) => statement.expression)
						: [callback.body];
				for (const expression of expressions) {
					if (expression.type === "CallExpression" && isConfigTeardown(expression, cleanupNames)) {
						context.report({
							message: "The Vitest config and setup file already run this teardown; delete it.",
							node: expression,
						});
					}
				}
			},
		};
	},
};

const plugin = {
	meta: { name: "app-server" },
	rules: {
		"no-config-teardown": noConfigTeardown,
		"no-only-to-be-defined": noOnlyToBeDefined,
	},
};

export default plugin;
