import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyPackages, findPackage, isNativePackage, packageName } from "./standalone.js";

// Why the real path: `findPackage` gives real paths, and `/tmp` on macOS is a symbolic link.
const root = realpathSync(mkdtempSync(join(tmpdir(), "app-server-standalone-")));

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Writes a package with a `package.json` and more files, and gives its directory. */
function writePackage(
	directory: string,
	manifest: Record<string, unknown>,
	files: Record<string, string> = {},
): string {
	for (const [path, content] of Object.entries({
		"package.json": JSON.stringify(manifest),
		...files,
	})) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), content);
	}
	return directory;
}

/** Links `node_modules/<name>` in `directory` to `target`, as pnpm does. */
function link(directory: string, name: string, target: string): void {
	mkdirSync(dirname(join(directory, "node_modules", name)), { recursive: true });
	symlinkSync(target, join(directory, "node_modules", name), "dir");
}

/** The version of the package that Node finds for `name` from the file `from`. */
function versionFrom(from: string, name: string): string {
	const manifest: { version: string } = JSON.parse(
		readFileSync(createRequire(from).resolve(`${name}/package.json`), "utf8"),
	);
	return manifest.version;
}

describe("packageName", () => {
	it("gives the package of a bare import, with its scope", () => {
		expect(packageName("react-dom/server")).toBe("react-dom");
		expect(packageName("@scope/name/sub/path")).toBe("@scope/name");
		expect(packageName("react")).toBe("react");
	});
});

describe("isNativePackage", () => {
	const project = join(root, "native");

	it("finds a package with a .node file", () => {
		const directory = writePackage(
			join(project, "node_modules/sqlite"),
			{ name: "sqlite" },
			{ "build/Release/sqlite.node": "" },
		);

		expect(isNativePackage(directory)).toBe(true);
	});

	it("finds a package whose installed platform package has the .node file", () => {
		writePackage(
			join(project, "node_modules/@parser/binding-linux-x64"),
			{ name: "@parser/binding-linux-x64" },
			{ "parser.linux-x64.node": "" },
		);
		const directory = writePackage(join(project, "node_modules/parser"), {
			name: "parser",
			optionalDependencies: {
				"@parser/binding-linux-x64": "1.0.0",
				"@parser/binding-darwin-arm64": "1.0.0",
			},
		});

		expect(isNativePackage(directory)).toBe(true);
	});

	it("does not find a JavaScript package, or one with a native package two levels down", () => {
		writePackage(join(project, "node_modules/wrapper"), {
			name: "wrapper",
			dependencies: { sqlite: "1.0.0" },
		});
		const directory = writePackage(join(project, "node_modules/framework"), {
			name: "framework",
			dependencies: { wrapper: "1.0.0", missing: "1.0.0" },
		});

		expect(isNativePackage(directory)).toBe(false);
		expect(isNativePackage(join(project, "node_modules/wrapper"))).toBe(true);
	});
});

describe("copyPackages", () => {
	// A pnpm layout: each package is in its own store directory, next to links to its dependencies.
	const project = join(root, "copy");
	const store = join(project, "node_modules/.pnpm");
	const storePackage = (id: string, name: string) => join(store, id, "node_modules", name);
	const server = join(project, "build/server");
	const target = join(server, "node_modules");

	beforeAll(() => {
		writePackage(
			storePackage("a@1.0.0", "a"),
			{
				name: "a",
				version: "1.0.0",
				dependencies: { b: "1.0.0", c: "2.0.0" },
				optionalDependencies: { "@native/linux-x64": "1.0.0", "@native/darwin-arm64": "1.0.0" },
				peerDependencies: { peer: "1.0.0" },
			},
			{ "index.js": "module.exports = 'a';", "data/words.txt": "read through __dirname" },
		);
		writePackage(storePackage("b@1.0.0", "b"), {
			name: "b",
			version: "1.0.0",
			dependencies: { a: "1.0.0" },
		});
		writePackage(storePackage("c@2.0.0", "c"), { name: "c", version: "2.0.0" });
		writePackage(storePackage("c@1.0.0", "c"), { name: "c", version: "1.0.0" });
		writePackage(storePackage("d@1.0.0", "d"), {
			name: "d",
			version: "1.0.0",
			dependencies: { c: "1.0.0" },
		});
		writePackage(
			storePackage("@native+linux-x64@1.0.0", "@native/linux-x64"),
			{ name: "@native/linux-x64", version: "1.0.0" },
			{ "addon.node": "binary" },
		);
		writePackage(storePackage("peer@1.0.0", "peer"), { name: "peer", version: "1.0.0" });
		link(join(store, "a@1.0.0"), "b", storePackage("b@1.0.0", "b"));
		link(join(store, "a@1.0.0"), "c", storePackage("c@2.0.0", "c"));
		link(join(store, "a@1.0.0"), "peer", storePackage("peer@1.0.0", "peer"));
		link(
			join(store, "a@1.0.0"),
			"@native/linux-x64",
			storePackage("@native+linux-x64@1.0.0", "@native/linux-x64"),
		);
		link(join(store, "b@1.0.0"), "a", storePackage("a@1.0.0", "a"));
		link(join(store, "d@1.0.0"), "c", storePackage("c@1.0.0", "c"));
		link(project, "a", storePackage("a@1.0.0", "a"));
		link(project, "d", storePackage("d@1.0.0", "d"));
		copyPackages(
			new Map(["a", "d"].map((name) => [name, findPackage(name, project) ?? ""] as const)),
			target,
		);
	});

	it("copies each package, whole, so Node finds it and its files from the build", () => {
		const requireFromBuild = createRequire(join(server, "app-server.js"));

		expect(requireFromBuild("a")).toBe("a");
		expect(readFileSync(join(target, "a/data/words.txt"), "utf8")).toBe("read through __dirname");
		expect(lstatSync(join(target, "a")).isSymbolicLink()).toBe(false);
	});

	it("copies the dependency closure, with the installed platform package and peers", () => {
		const fromA = join(target, "a/index.js");

		expect(versionFrom(fromA, "b")).toBe("1.0.0");
		expect(versionFrom(fromA, "peer")).toBe("1.0.0");
		expect(readFileSync(join(target, "@native/linux-x64/addon.node"), "utf8")).toBe("binary");
		expect(() => createRequire(fromA).resolve("@native/darwin-arm64")).toThrow(
			"Cannot find module",
		);
		// Why: `b` depends on `a`, and the cycle ends at the copy of `a` that is there.
		expect(realpathSync(createRequire(join(target, "b/index.js")).resolve("a"))).toBe(
			join(target, "a/index.js"),
		);
	});

	it("does not copy out of the target for a dependency key that is not a package name", () => {
		const outside = join(root, "outside");
		const evil = writePackage(
			join(outside, "node_modules/evil"),
			{ name: "evil", dependencies: { "..": "1.0.0", "../assets": "1.0.0", "@scope/..": "1.0.0" } },
			{ "index.js": "", "assets/package.json": "{}" },
		);
		copyPackages(new Map([["evil", evil]]), join(outside, "build/server/node_modules"));

		expect(readdirSync(join(outside, "build/server"))).toStrictEqual(["node_modules"]);
		expect(readdirSync(join(outside, "build/server/node_modules"))).toStrictEqual(["evil"]);
	});

	it("gives each package the version of a dependency that it installed", () => {
		expect(versionFrom(join(target, "a/index.js"), "c")).toBe("2.0.0");
		expect(versionFrom(join(target, "d/index.js"), "c")).toBe("1.0.0");
	});
});
