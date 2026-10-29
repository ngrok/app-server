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

type Fixture = { rule: string; source: string; fileName?: string };

/** Writes one fixture and a config with one plugin rule on. */
function writeFixture({ rule, source, fileName = "a.ts" }: Fixture): void {
	writeFileSync(
		join(rootDirectory, ".oxlintrc.json"),
		JSON.stringify({
			jsPlugins: [pluginPath],
			categories: {},
			rules: { [`app-server/${rule}`]: "error" },
		}),
	);
	writeFileSync(join(rootDirectory, fileName), source);
}

/** Lints one fixture with one plugin rule on, and returns the rule IDs that oxlint reports. */
function lint({ rule, source, fileName = "a.ts" }: Fixture): string[] {
	writeFixture({ rule, source, fileName });
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
	writeFixture({ rule, source });
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
		invalid: [
			"try { run(); } catch (e) { report(e); }",
			"const handle = (evt: Event) => evt;",
			"const { el } = refs;",
			"function first([e]: Error[]) { return e; }",
		],
		valid: [
			"try { run(); } catch (error) { report(error); }",
			"const value = { e: 1 };",
			"const { e: event } = events;",
		],
	},
	{
		rule: "no-boolean-positional-param",
		invalid: [
			"function flagRow(label: string, enabled: boolean) {}",
			"const toggle = (value: string, force?: boolean | undefined) => value;",
			"function flagRow(label: string, enabled: boolean = false) {}",
		],
		valid: [
			"function flagRow({ label, enabled }: { label: string; enabled: boolean }) {}",
			"function onOpenChange(id: string, open: boolean) {}",
			"function setEnabled(enabled: boolean) {}",
		],
	},
	{
		rule: "prefer-function-declaration",
		invalid: [
			"export const double = (value: number) => value * 2;",
			"let double = function (value: number) { return value * 2; };",
		],
		valid: [
			"export function double(value: number) { return value * 2; }",
			"export const handler: Handler = (event) => event.id;",
			"function outer() { const inner = () => 1; return inner; }",
		],
	},
	{
		rule: "require-suppression-reason",
		invalid: [
			"// oxlint-disable-next-line no-console\nconsole.log(1);",
			"// eslint-disable-next-line no-console --\nconsole.log(1);",
		],
		valid: [
			"// oxlint-disable-next-line no-console -- the CLI prints its usage.\nconsole.log(1);",
			"// eslint-disable-next-line no-console -- the CLI prints its usage.\nconsole.log(1);",
		],
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
			"await new Promise((resolve) => { setTimeout(({ resolve }) => resolve(), 100, deferred); });",
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
		invalid: [
			"afterEach(() => { vi.restoreAllMocks(); });",
			"beforeEach(() => vi.unstubAllEnvs());",
		],
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

describe.each([
	{
		name: "a list with the marker",
		source: "const a = 1;\nconst b = 2;\nexport {\n\t//,\n\ta,\n\tb,\n};\n",
	},
	{
		name: "a list that holds a line comment",
		source: "const a = 1;\nconst b = 2;\nexport {\n\ta, // keep\n\tb,\n};\n",
	},
	{ name: "one specifier", source: "const a = 1;\nexport { a };\n" },
	{
		name: "a list wider than printWidth",
		source: `export { ${Array.from({ length: 8 }, (_, index) => `exportedNameNumber${index}`).join(", ")} } from "./names.js";\n`,
	},
])("multiline-exports allows $name", ({ source }) => {
	it("reports nothing", () => {
		expect(lint({ rule: "multiline-exports", source })).toStrictEqual([]);
	});
});

describe("multiline-exports", () => {
	it("reports a list with a block comment, but does not fix it", () => {
		const source = "const a = 1;\nconst b = 2;\nexport { a, /* keep */ b };\n";

		expect(lint({ rule: "multiline-exports", source })).toStrictEqual(["multiline-exports"]);
		expect(fix({ rule: "multiline-exports", source })).toBe(source);
	});

	it("expands a short export list and adds the `//,` marker", () => {
		const source = "const a = 1;\nconst b = 2;\nexport { a, b };\n";

		expect(fix({ rule: "multiline-exports", source })).toBe(
			"const a = 1;\nconst b = 2;\nexport {\n\t//,\n\ta,\n\tb,\n};\n",
		);
	});
});
