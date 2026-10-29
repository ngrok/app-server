/**
 * Requires a `function` declaration for a named function at module scope.
 * From the frontend repo.
 *
 * Scope: a module-scope `const`, `let`, or `var` whose value is an arrow
 * function or a function expression, exported or not. A binding with a type
 * annotation is out of scope, because the annotation is a contract that a
 * declaration cannot state. Functions inside other functions are out of scope.
 *
 * @example
 * // ❌ Incorrect
 * export const formatBytes = (bytes: number) => `${bytes} B`;
 * const useThing = () => useContext(ThingContext);
 *
 * // ✅ Correct
 * export function formatBytes(bytes: number) {
 * 	return `${bytes} B`;
 * }
 * export const handler: Handler = (event) => event.id;
 */

const FUNCTION_TYPES = new Set(["ArrowFunctionExpression", "FunctionExpression"]);

const preferFunctionDeclaration = {
	meta: {},
	create(context) {
		return {
			VariableDeclaration(node) {
				const parent = node.parent;
				const atModuleScope =
					parent?.type === "Program" ||
					(parent?.type === "ExportNamedDeclaration" && parent.parent?.type === "Program");
				if (!atModuleScope) {
					return;
				}
				for (const declarator of node.declarations) {
					// Why the annotation check: a typed binding states a contract that a declaration cannot.
					const untyped = declarator.id.type === "Identifier" && !declarator.id.typeAnnotation;
					if (untyped && declarator.init && FUNCTION_TYPES.has(declarator.init.type)) {
						context.report({
							message: `Declare \`${declarator.id.name}\` with \`function\`. A module-scope arrow or function expression is allowed only with a type annotation on the binding.`,
							node: declarator,
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
		"prefer-function-declaration": preferFunctionDeclaration,
	},
};

export default plugin;
