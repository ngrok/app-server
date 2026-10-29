// Custom oxlint rules for the conventions that no built-in rule checks. Most come from the mantle
// and frontend repos, with fixes for the stricter rules here.

import descriptiveNames from "./oxlint-rules/descriptive-names.js";
import multilineExports from "./oxlint-rules/multiline-exports.js";
import noBooleanPositionalParam from "./oxlint-rules/no-boolean-positional-param.js";
import noSleepInTests from "./oxlint-rules/no-sleep-in-tests.js";
import preferFunctionDeclaration from "./oxlint-rules/prefer-function-declaration.js";
import preferNullCheck from "./oxlint-rules/prefer-null-check.js";
import requireSuppressionReason from "./oxlint-rules/require-suppression-reason.js";
import testAssertions from "./oxlint-rules/test-assertions.js";

const plugin = {
	meta: { name: "app-server" },
	rules: {
		...descriptiveNames.rules,
		...multilineExports.rules,
		...noBooleanPositionalParam.rules,
		...noSleepInTests.rules,
		...preferFunctionDeclaration.rules,
		...preferNullCheck.rules,
		...requireSuppressionReason.rules,
		...testAssertions.rules,
	},
};

export default plugin;
