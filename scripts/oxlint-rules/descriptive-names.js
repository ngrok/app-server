/**
 * Disallows the abbreviated binding names `e`, `evt`, and `el`. Write
 * `error` or `event`, and `element`. The rule checks only names that code
 * declares, such as parameters, variables, and catch bindings, so an object
 * key such as `{ e: … }` stays allowed.
 *
 * @example
 * // ❌ Incorrect
 * onClick={(e) => e.preventDefault()}
 * try { run(); } catch (e) { report(e); }
 *
 * // ✅ Correct
 * onClick={(event) => event.preventDefault()}
 * try { run(); } catch (error) { report(error); }
 */

import { boundIdentifiers } from "./ast.js";

const REPLACEMENTS = new Map([
	["e", "`error` or `event`"],
	["evt", "`event`"],
	["el", "`element`"],
]);

const descriptiveNames = {
	meta: {},
	create(context) {
		function check(pattern) {
			for (const identifier of boundIdentifiers(pattern)) {
				const replacement = REPLACEMENTS.get(identifier.name);
				if (replacement) {
					context.report({
						message: `Name this binding ${replacement}, not \`${identifier.name}\`. See AGENTS.md.`,
						node: identifier,
					});
				}
			}
		}

		function checkParams(node) {
			for (const param of node.params) {
				check(param);
			}
		}

		return {
			ArrowFunctionExpression: checkParams,
			CatchClause(node) {
				check(node.param);
			},
			FunctionDeclaration: checkParams,
			FunctionExpression: checkParams,
			VariableDeclarator(node) {
				check(node.id);
			},
		};
	},
};

const rules = {
	"descriptive-names": descriptiveNames,
};

export default rules;
