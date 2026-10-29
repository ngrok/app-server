import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const pluginPath = join(import.meta.dirname, "oxlint-plugin-app-server.js");
const oxlintPath = join(import.meta.dirname, "..", "node_modules", ".bin", "oxlint");

let rootDirectory = "";

beforeEach(() => {
	rootDirectory = mkdtempSync(join(tmpdir(), "app-server-oxlint-plugin-"));
	return () => {
		rmSync(rootDirectory, { recursive: true, force: true });
	};
});

/** Lints one fixture with one plugin rule on, and returns the rule IDs that oxlint reports. */
function lint({
	rule,
	source,
	fileName = "a.ts",
}: {
	rule: string;
	source: string;
	fileName?: string;
}): string[] {
	writeFileSync(
		join(rootDirectory, ".oxlintrc.json"),
		JSON.stringify({
			jsPlugins: [pluginPath],
			categories: {},
			rules: { [`app-server/${rule}`]: "error" },
		}),
	);
	writeFileSync(join(rootDirectory, fileName), source);
	const result = spawnSync(oxlintPath, ["--format=unix", fileName], {
		cwd: rootDirectory,
		encoding: "utf8",
	});
	if (result.error != null) {
		throw result.error;
	}
	const ruleIds = Array.from(
		result.stdout.matchAll(/\[Error\/app-server\((?<id>[a-z-]+)\)\]/gu),
		(match) => match.groups?.id ?? "",
	);
	// Why check the exit: a config error or a rule that throws also prints no rule diagnostic.
	if (ruleIds.length === 0 && result.status !== 0) {
		throw new Error(`oxlint exited with ${result.status}: ${result.stdout}${result.stderr}`);
	}
	return ruleIds;
}

/** Runs `oxlint --fix` on one fixture with one plugin rule on, and returns the fixed source. */
function fix({ rule, source }: { rule: string; source: string }): string {
	lint({ rule, source });
	spawnSync(oxlintPath, ["--fix", "a.ts"], { cwd: rootDirectory, encoding: "utf8" });
	return readFileSync(join(rootDirectory, "a.ts"), "utf8");
}

describe.each([
	{
		rule: "prefer-null-check",
		invalid: ["if (value === undefined) {}", "if (undefined !== value) {}"],
		valid: [
			"if (value == null) {}",
			"if (value != null) {}",
			'if (typeof Bun === "undefined") {}',
			"// oxlint-disable-next-line app-server/prefer-null-check -- `null` means a cleared value here.\nif (value === undefined) {}",
		],
	},
	{
		rule: "descriptive-names",
		invalid: ["try { run(); } catch (e) { report(e); }", "const handle = (evt: Event) => evt;"],
		valid: ["try { run(); } catch (error) { report(error); }", "const value = { e: 1 };"],
	},
	{
		rule: "no-boolean-positional-param",
		invalid: ["function flagRow(label: string, enabled: boolean) {}"],
		valid: [
			"function flagRow({ label, enabled }: { label: string; enabled: boolean }) {}",
			"function onOpenChange(id: string, open: boolean) {}",
			"function setEnabled(enabled: boolean) {}",
		],
	},
	{
		rule: "prefer-function-declaration",
		invalid: ["export const double = (value: number) => value * 2;"],
		valid: [
			"export function double(value: number) { return value * 2; }",
			"export const handler: Handler = (event) => event.id;",
			"function outer() { const inner = () => 1; return inner; }",
		],
	},
	{
		rule: "require-suppression-reason",
		invalid: ["// oxlint-disable-next-line no-console\nconsole.log(1);"],
		valid: ["// oxlint-disable-next-line no-console -- the CLI prints its usage.\nconsole.log(1);"],
	},
	{
		rule: "no-sleep-in-tests",
		invalid: [
			"await new Promise((resolve) => setTimeout(resolve, 100));",
			"await new Promise((resolve) => { setTimeout(() => resolve(), 100); });",
		],
		valid: [
			"await new Promise((resolve) => { queueMicrotask(resolve); });",
			'await new Promise((resolve) => { source.once("ready", resolve); setTimeout(() => deferred.resolve(), 100); });',
		],
	},
	{
		rule: "no-only-to-be-defined",
		invalid: [
			'it("loads", () => { expect(result).toBeDefined(); });',
			'it.each([1])("loads %s", () => { expect(result).toBeDefined(); });',
			'it.concurrent("loads", () => { expect(result).toBeDefined(); });',
			'it.each`value`("loads $value", () => { expect(result).toBeDefined(); });',
		],
		valid: [
			'it("loads", () => { expect(result).toBeDefined(); expect(result.id).toBe(1); });',
			'it("clears", () => { expect(result).not.toBeDefined(); });',
		],
	},
	{
		rule: "no-config-teardown",
		invalid: ["afterEach(() => { vi.restoreAllMocks(); });"],
		valid: ["afterEach(() => { server.close(); });"],
	},
])("$rule", ({ rule, invalid, valid }) => {
	it.each(invalid)("reports %s", (source) => {
		expect(lint({ rule, source })).toStrictEqual([rule]);
	});

	it.each(valid)("allows %s", (source) => {
		expect(lint({ rule, source })).toStrictEqual([]);
	});
});

describe("multiline-exports", () => {
	it("expands a short export list and adds the `//,` marker", () => {
		const source = "const a = 1;\nconst b = 2;\nexport { a, b };\n";

		expect(fix({ rule: "multiline-exports", source })).toBe(
			"const a = 1;\nconst b = 2;\nexport {\n\t//,\n\ta,\n\tb,\n};\n",
		);
	});
});
