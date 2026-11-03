/**
 * Disallows `URL.canParse(x)` in a function that also calls `new URL(x)` with
 * the same arguments. The pair parses the URL twice. `URL.parse(x)` parses it
 * once and returns `null` for a URL that is not valid.
 *
 * @example
 * // ❌ Incorrect
 * if (!URL.canParse(value)) return null;
 * return new URL(value).protocol;
 *
 * // ✅ Correct
 * return URL.parse(value)?.protocol ?? null;
 */

const FUNCTION_TYPES = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
]);

function isUrlCanParse(node) {
	const { callee } = node;
	return (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.object.type === "Identifier" &&
		callee.object.name === "URL" &&
		callee.property.name === "canParse"
	);
}

/** The nearest function that holds `node`, or the program. */
function enclosingScope(node) {
	let current = node.parent;
	while (current.parent != null && !FUNCTION_TYPES.has(current.type)) {
		current = current.parent;
	}
	return current;
}

/** Whether `root` holds a `new URL(…)` whose argument text is `argumentText`. */
function hasMatchingConstructor(root, argumentText, getText) {
	const pending = [root];
	while (pending.length > 0) {
		const node = pending.pop();
		if (
			node.type === "NewExpression" &&
			node.callee.type === "Identifier" &&
			node.callee.name === "URL" &&
			node.arguments.map(getText).join(",") === argumentText
		) {
			return true;
		}
		for (const [key, value] of Object.entries(node)) {
			const children =
				key === "parent" || value == null || typeof value !== "object" ? [] : [value];
			for (const child of children.flat()) {
				if (child != null && typeof child.type === "string") {
					pending.push(child);
				}
			}
		}
	}
	return false;
}

const preferUrlParse = {
	meta: {},
	create(context) {
		const sourceCode = context.getSourceCode();
		const getText = (node) => sourceCode.getText(node);
		return {
			CallExpression(node) {
				if (!isUrlCanParse(node) || node.arguments.length === 0) {
					return;
				}
				const argumentText = node.arguments.map(getText).join(",");
				if (!hasMatchingConstructor(enclosingScope(node), argumentText, getText)) {
					return;
				}
				context.report({
					message:
						"`URL.canParse(x)` then `new URL(x)` parses the URL twice. Use `URL.parse(x)`, which returns `null` for a URL that is not valid. See docs/principles/keep-the-hot-path-lean.md.",
					node,
				});
			},
		};
	},
};

const rules = { "prefer-url-parse": preferUrlParse };

export default rules;
