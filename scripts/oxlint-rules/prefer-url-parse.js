/**
 * Disallows `URL.canParse(x)` in a function that also calls `new URL(x)` with
 * the same arguments, when the function does not write to `x` between them.
 *
 * Why: the pair parses the URL twice. `URL.parse(x)` parses it once and
 * returns `null` for a URL that is not valid.
 *
 * The rule checks only arguments that read the same value each time: an
 * identifier, a literal, or a property chain of those. It does not look in a
 * nested function, which has its own bindings and runs on its own.
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

/** Whether `node` reads the same value each time it runs. A call, for example, can return a new value. */
function isStable(node) {
	switch (node.type) {
		case "Identifier":
		case "Literal":
		case "ThisExpression": {
			return true;
		}
		case "TemplateLiteral": {
			return node.expressions.every(isStable);
		}
		case "MemberExpression": {
			return isStable(node.object) && (!node.computed || isStable(node.property));
		}
		default: {
			return false;
		}
	}
}

/** The nearest function that holds `node`, or the program. */
function enclosingScope(node) {
	let current = node.parent;
	while (current.parent != null && !FUNCTION_TYPES.has(current.type)) {
		current = current.parent;
	}
	return current;
}

/**
 * Each node under `root`, `root` included.
 *
 * @yields Each node. With `skipFunctions`, it does not go into a function under `root`.
 */
function* nodesUnder(root, { skipFunctions }) {
	const pending = [root];
	while (pending.length > 0) {
		const node = pending.pop();
		yield node;
		for (const [key, value] of Object.entries(node)) {
			const children =
				key === "parent" || value == null || typeof value !== "object" ? [] : [value];
			for (const child of children.flat()) {
				if (typeof child?.type === "string" && !(skipFunctions && FUNCTION_TYPES.has(child.type))) {
					pending.push(child);
				}
			}
		}
	}
}

/** The name of each identifier under `node`. */
function identifierNames(node) {
	const names = new Set();
	for (const child of nodesUnder(node, { skipFunctions: false })) {
		if (child.type === "Identifier") {
			names.add(child.name);
		}
	}
	return names;
}

/** Whether `root` holds a `new URL(…)` whose argument text is `argumentText`. */
function hasMatchingConstructor(root, argumentText, getText) {
	for (const node of nodesUnder(root, { skipFunctions: true })) {
		if (
			node.type === "NewExpression" &&
			node.callee.type === "Identifier" &&
			node.callee.name === "URL" &&
			node.arguments.map(getText).join(",") === argumentText
		) {
			return true;
		}
	}
	return false;
}

/** The binding or property that `node` writes, or `null` when `node` is not a write. */
function writeTarget(node) {
	if (node.type === "AssignmentExpression") {
		return node.left;
	}
	if (node.type === "UpdateExpression") {
		return node.argument;
	}
	return null;
}

/** Whether code in `root`, nested functions included, writes to one of `names`. */
function writesTo(root, names) {
	for (const node of nodesUnder(root, { skipFunctions: false })) {
		const target = writeTarget(node);
		if (target != null && [...identifierNames(target)].some((name) => names.has(name))) {
			return true;
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
				if (
					!isUrlCanParse(node) ||
					node.arguments.length === 0 ||
					!node.arguments.every(isStable)
				) {
					return;
				}
				const scope = enclosingScope(node);
				const argumentText = node.arguments.map(getText).join(",");
				const names = new Set(node.arguments.flatMap((argument) => [...identifierNames(argument)]));
				if (!hasMatchingConstructor(scope, argumentText, getText) || writesTo(scope, names)) {
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
