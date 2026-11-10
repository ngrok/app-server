// Why: the north star and the principles steer each change only while each list that names them
// agrees with its source and each link opens.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
/** The text of the repo file at `path`. */
function read(path: string): string {
	return readFileSync(join(root, path), "utf8");
}

/** The text of the `## <heading>` section of `markdown`, up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
	const start = markdown.indexOf(`\n## ${heading}\n`);
	const end = markdown.indexOf("\n## ", start + 1);
	return start === -1 ? "" : markdown.slice(start, end === -1 ? undefined : end);
}

/** The bold names of the list items of `markdown`, such as `Correct` for `- **Correct:** …`. */
function boldItems(markdown: string): string[] {
	return [...markdown.matchAll(/^- \*\*(?<name>[^*:]+):\*\*/gmu)].map(
		(match) => match.groups?.name ?? "",
	);
}

const goals = [...read("docs/north-star.md").matchAll(/^## (?<name>.+)$/gmu)]
	.map((match) => match.groups?.name ?? "")
	.filter((name) => name !== "How to use the goals");

describe("the north star", () => {
	it("has six goals", () => {
		expect(goals).toHaveLength(6);
	});

	it("lists the same goals in AGENTS.md and in the PR template", () => {
		expect(boldItems(section(read("AGENTS.md"), "North star"))).toStrictEqual(goals);
		expect(
			boldItems(section(read(".github/pull_request_template.md"), "North star")),
		).toStrictEqual(goals);
	});
});

describe("the principles", () => {
	it("lists each principle file in AGENTS.md", () => {
		const listed = section(read("AGENTS.md"), "Principles");
		const files = readdirSync(join(root, "docs/principles")).filter(
			(name) => name.endsWith(".md") && name !== "README.md",
		);

		expect(files.filter((name) => !listed.includes(`./docs/principles/${name}`))).toStrictEqual([]);
	});

	it("has a link that opens for each relative link in AGENTS.md and docs", () => {
		const docs = [
			"AGENTS.md",
			...readdirSync(join(root, "docs"), { recursive: true, encoding: "utf8" })
				.filter((name) => name.endsWith(".md"))
				.map((name) => join("docs", name)),
		];
		const broken = docs.flatMap((doc) =>
			[...read(doc).matchAll(/\]\((?<target>\.{1,2}\/[^)#\s]+)/gu)]
				.map((match) => match.groups?.target ?? "")
				.filter((target) => !existsSync(resolve(root, dirname(doc), target)))
				.map((target) => `${doc}: ${target}`),
		);

		expect(broken).toStrictEqual([]);
	});
});
