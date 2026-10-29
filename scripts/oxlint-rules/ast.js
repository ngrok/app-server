// AST helpers that more than one rule uses.

/** Whether a node is an arrow function or a function expression. */
export function isFunction(node) {
	return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

/** The expressions that a function body states: each expression statement, or a concise arrow body. */
export function bodyExpressions(fn) {
	if (fn.body.type !== "BlockStatement") {
		return [fn.body];
	}
	return fn.body.body
		.filter((statement) => statement.type === "ExpressionStatement")
		.map((statement) => statement.expression);
}

/**
 * The identifiers that a binding pattern declares.
 *
 * @yields Each `Identifier` node in the pattern, nested patterns included.
 */
export function* boundIdentifiers(pattern) {
	if (pattern == null) {
		return;
	}
	switch (pattern.type) {
		case "Identifier": {
			yield pattern;
			return;
		}
		case "AssignmentPattern": {
			yield* boundIdentifiers(pattern.left);
			return;
		}
		case "RestElement": {
			yield* boundIdentifiers(pattern.argument);
			return;
		}
		case "ArrayPattern": {
			for (const element of pattern.elements) {
				yield* boundIdentifiers(element);
			}
			return;
		}
		case "ObjectPattern": {
			for (const property of pattern.properties) {
				yield* boundIdentifiers(property.type === "RestElement" ? property : property.value);
			}
			return;
		}
		case "TSParameterProperty": {
			yield* boundIdentifiers(pattern.parameter);
			break;
		}
		default:
	}
}
