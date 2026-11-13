// Why: the north star and the principles steer each change only while each list that names them
// agrees with its source and each link opens.
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { defaultPlugins, runtimeEnv } from "../src/core/index.ts";
import type { AppServer } from "../src/core/index.ts";
import { createTestServer } from "../src/testing/index.ts";
import tsdownConfig from "../tsdown.config.ts";

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

const { entry } = tsdownConfig;
/** The source file of each file of the build, such as `./src/core/index.ts` for `index`. */
const sources: Record<string, unknown> =
	typeof entry === "object" && !Array.isArray(entry) ? entry : {};
/** The source module of each import path of the package, such as `@ngrok/app-server/vite`. */
const packageModules = Object.fromEntries(
	Object.entries(packageJson.exports).flatMap(([subpath, target]) => {
		const source = typeof target === "string" ? undefined : sources[basename(target.import, ".js")];
		return typeof source === "string"
			? [[join(packageJson.name, subpath), [join(root, source)]]]
			: [];
	}),
);

/**
 * The names that a README fragment uses with no import. Why a list for the subpaths: to load
 * each module for its export names would start Vite in this test.
 */
const FRAGMENT_IMPORTS: Record<string, readonly string[]> = {
	"@ngrok/app-server": Object.keys(await import("../src/core/index.ts")),
	"@ngrok/app-server/node/vite": ["node"],
	"@ngrok/app-server/react-router": ["runtime"],
	"@ngrok/app-server/react-router/vite": ["reactRouterAdapter"],
	"@ngrok/app-server/vite": ["appServer"],
	"@tanstack/react-router": ["createRouter"],
};

/** The names that the README says stand for the app's own code, and the framework's types. */
const APP_CODE = `
declare function hasSession(request: Request): Promise<boolean>;
declare function markdownFor(path: string | undefined): string | undefined;
declare function watch(options: { signal: AbortSignal }): AsyncIterable<unknown>;
declare function route(path: string, file: string): unknown;
declare const datadogRum: { addAction: (name: string, context: object) => void };
declare const db: { ping: () => Promise<boolean> };
declare const error: Error;
declare const policy: (document: { scriptSrc: string }) => string;
declare const routeTree: import("@tanstack/react-router").AnyRoute;
declare const serverModule: unknown;
declare const url: string;
declare const userId: string;
declare const username: string;
declare const password: string;
declare const mySlogger: Record<
	"debug" | "info" | "warn" | "error",
	(message: string, attributes: Readonly<Record<string, unknown>>) => void
>;
declare namespace Route {
	type LoaderArgs = {
		request: Request;
		params: Record<string, string | undefined>;
		context: import("react-router").RouterContextProvider;
	};
}
`;

/** Each fenced block of `markdown` in `language`, with the line of its fence. */
function codeBlocks(markdown: string, language: string): { line: number; code: string }[] {
	const fence = new RegExp(
		`^(?<indent>[ \\t]*)\`\`\`${language}\\n(?<code>[\\s\\S]*?)^\\k<indent>\`\`\`$`,
		"gmu",
	);
	return [...markdown.matchAll(fence)].map((match) => ({
		line: markdown.slice(0, match.index).split("\n").length,
		code: (match.groups?.code ?? "").replaceAll(
			new RegExp(`^${match.groups?.indent ?? ""}`, "gmu"),
			"",
		),
	}));
}

/** Whether `code` uses the identifier `name`, and neither imports nor declares it. */
function usesUndeclared(code: string, name: string): boolean {
	const uncommented = code.replaceAll(/\/\/.*$/gmu, "");
	return (
		new RegExp(`(?<![.\\w"'\`-])${name}\\b(?!["'\`:-])`, "u").test(uncommented) &&
		!new RegExp(`(?:import[^;]*\\b|(?:const|function|interface|type) )${name}\\b`, "u").test(
			uncommented,
		)
	);
}

describe("the README examples", () => {
	const readme = read("README.md");

	it("type-checks each TypeScript example against the package", () => {
		const directory = mkdtempSync(join(tmpdir(), "app-server-readme-"));
		try {
			// Why a link: an example then resolves `hono` and `zod` to the copies that the package uses.
			symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
			writeFileSync(join(directory, "app-code.d.ts"), APP_CODE);
			writeFileSync(
				join(directory, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						target: "ES2025",
						module: "NodeNext",
						moduleDetection: "force",
						lib: ["ES2025", "DOM"],
						types: ["node"],
						strict: true,
						skipLibCheck: true,
						noEmit: true,
						allowImportingTsExtensions: true,
						paths: packageModules,
					},
					include: ["*.mts", "*.d.ts"],
				}),
			);
			for (const { line, code } of codeBlocks(readme, "ts")) {
				const imports = Object.entries(FRAGMENT_IMPORTS).flatMap(([module, names]) => {
					const used = names.filter((name) => usesUndeclared(code, name));
					return used.length === 0 ? [] : [`import { ${used.join(", ")} } from "${module}";`];
				});
				const pluginType = usesUndeclared(code, "Plugin")
					? ['import type { Plugin } from "@ngrok/app-server";']
					: [];
				// Why one line: an error then names the line of the README.
				writeFileSync(
					join(directory, `readme-line-${line}.mts`),
					`${[...imports, ...pluginType].join(" ")}\n${code}`,
				);
			}
			const { status, stdout } = spawnSync(
				join(root, "node_modules/.bin/tsc"),
				["--project", directory],
				{ encoding: "utf8" },
			);

			expect({ status, errors: stdout }).toStrictEqual({ status: 0, errors: "" });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);

	it("keeps a visitor with no session out of `/app` in each letter case, as the auth example is written", async () => {
		const [example] = codeBlocks(section(readme, "Protect pages"), "ts");
		const directory = mkdtempSync(join(tmpdir(), "app-server-readme-"));
		const file = join(directory, "server.ts");
		writeFileSync(
			file,
			`const hasSession = async (request: Request) => request.headers.has("Cookie");\n${example?.code
				.replaceAll('"@ngrok/app-server"', JSON.stringify(join(root, "src/core/index.ts")))
				// Why: the example has the default sink, and its request lines are noise in a test run.
				.replace("createServer({", "createServer({ logger: { log: () => {} },")}`,
		);
		const { default: app } = (await import(file)) as { default: AppServer };
		const server = await createTestServer({
			app,
			files: { "app/index.html": "<!doctype html><p>private</p>" },
			// Why: React Router and TanStack Router match a path in any letter case.
			framework: async () => new Response("rendered", { headers: { "Content-Type": "text/html" } }),
		});
		try {
			const statuses = await Promise.all(
				["/app", "/APP", "/App/settings", "/APP.data"].map(
					async (path) => (await server.request(path)).status,
				),
			);
			const signedIn = await server.request("/APP/settings", { headers: { Cookie: "session=1" } });

			expect(statuses).toStrictEqual([302, 302, 302, 302]);
			expect(signedIn.status).toBe(200);
		} finally {
			await server.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("the README and the code", () => {
	const readme = read("README.md");

	it("names each default plugin in the pipeline section, in order", () => {
		const names = defaultPlugins({
			noindex: true,
			contentSecurityPolicy: { policy: ({ scriptSrc }) => `script-src ${scriptSrc}` },
			env: runtimeEnv({
				"~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
			}),
			redirects: [{ from: "/old", to: "/new" }],
		}).map((plugin) => plugin.name);
		const sentence = /The names, in the order of the list, are (?<names>[^.]+)\./u.exec(
			section(readme, "The pipeline"),
		);

		expect(
			[...(sentence?.groups?.names ?? "").matchAll(/`(?<name>[^`]+)`/gu)].map(
				(match) => match.groups?.name,
			),
		).toStrictEqual(names);
	});

	it("lists each log line of the server in the logs section, with its level", () => {
		const source = readdirSync(join(root, "src/core"), { recursive: true, encoding: "utf8" })
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
			// Why drop the comment lines: a JSDoc example is not a line that the server writes.
			.map((name) => read(join("src/core", name)).replaceAll(/^\s*(?:\*|\/\/).*$/gmu, ""))
			.join("\n");
		const lines = [
			...source.matchAll(/level: "(?<level>\w+)",\s*message: "(?<message>[^"]+)"/gu),
			...source.matchAll(/\.(?<level>debug|info|warn|error)\(\s*"(?<message>[^"]+)"/gu),
		].map((match) => `| \`${match.groups?.message}\` | \`${match.groups?.level}\` |`);
		// Why: the formatter pads each cell of a table.
		const logs = section(readme, "Logs").replaceAll(/ +\|/gu, " |");

		expect(lines.length).toBeGreaterThan(10);
		expect(lines.filter((line) => !logs.includes(line))).toStrictEqual([]);
	});

	it("states the Node.js versions of `engines.node`", () => {
		const { major, open } =
			/^(?<open>>=)?\^?(?<major>\d+)/u.exec(packageJson.engines.node)?.groups ?? {};
		const versions = `Node.js ${major}${open == null ? "" : "+"}, `;

		expect(readme).toContain(`- The app needs ${versions}`);
		expect(section(readme, "Requirements")).toContain(`- ${versions}`);
	});

	it("installs the package with each peer dependency that is not optional, so an app gets one copy of each", () => {
		const optional: Record<string, { optional?: boolean }> = packageJson.peerDependenciesMeta;
		const required = Object.keys(packageJson.peerDependencies).filter(
			(name) => optional[name]?.optional !== true,
		);
		const line = /^pnpm add -E (?<packages>.+)$/mu.exec(section(readme, "Install"));

		expect(line?.groups?.packages?.split(" ")).toStrictEqual([packageJson.name, ...required]);
	});

	it("states the Hono versions of the peer range", () => {
		const floor = /^\^(?<version>[\d.]+)$/u.exec(packageJson.peerDependencies.hono)?.groups
			?.version;

		expect(section(readme, "Requirements")).toContain(`- Hono ${floor}+\n`);
	});
});
