import { cpSync, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

/**
 * A package name: an optional scope and a name, each with no `/` or `\` and
 * no `.` at the start. Why: a name such as `..` or `../x` in a manifest must
 * not move a copy out of `node_modules`.
 */
const PACKAGE_NAME = /^(?:@[^./\\][^/\\]*\/)?[^./\\][^/\\]*$/u;

/**
 * The package names in the dependency `fields` of the `package.json` in
 * `directory`. It skips a key that is not a package name.
 *
 * @example
 * dependencyNames("/app/node_modules/react-dom", ["peerDependencies"]); // => ["react"]
 */
export function dependencyNames(directory: string, fields: readonly string[]): string[] {
	const manifest: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const names = fields.flatMap((field) => {
		const value: unknown =
			typeof manifest === "object" && manifest != null ? Reflect.get(manifest, field) : undefined;
		return typeof value === "object" && value != null
			? Object.keys(value).filter((name) => PACKAGE_NAME.test(name))
			: [];
	});
	return [...new Set(names)];
}

/**
 * The package name of a bare import.
 *
 * @example
 * packageName("@scope/name/sub/path"); // => "@scope/name"
 */
export function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
}

/**
 * Code that finds a file next to its own module: a relative `new URL()` on
 * `import.meta.url`, `fileURLToPath(import.meta.url)`, or
 * `import.meta.dirname`.
 */
const OWN_FILE =
	/new\s+URL\(\s*(?<quote>["'`])\.{1,2}\/[^"'`]*\k<quote>\s*,\s*import\.meta\.url\s*\)|fileURLToPath\(\s*import\.meta\.url\s*\)|import\.meta\.(?:dirname|filename)\b/u;

/**
 * Whether the module `file` finds a file next to itself, such as
 * `@vercel/og`, which reads `resvg.wasm` through
 * `new URL("./resvg.wasm", import.meta.url)`. Why: in the bundle,
 * `import.meta.url` is the URL of the bundle, so the file is not there.
 *
 * @example
 * readsOwnFiles("/app/node_modules/@vercel/og/dist/index.node.js"); // => true
 */
export function readsOwnFiles(file: string): boolean {
	return OWN_FILE.test(readFileSync(file, "utf8"));
}

/**
 * The real path of the directory of package `name`, as Node finds it from the
 * directory `from`: in each `node_modules` directory above `from`. Else
 * `undefined`. The real path follows the symbolic links of pnpm's layout.
 *
 * @example
 * findPackage("react", "/app/build/server"); // => "/app/node_modules/.pnpm/react@19.3.1/node_modules/react"
 */
export function findPackage(name: string, from: string): string | undefined {
	for (let directory = from; ; directory = dirname(directory)) {
		const candidate = join(directory, "node_modules", name);
		if (basename(directory) !== "node_modules" && existsSync(join(candidate, "package.json"))) {
			return realpathSync(candidate);
		}
		if (dirname(directory) === directory) {
			return undefined;
		}
	}
}

/**
 * The directory of package `name` that holds `file`: the nearest directory
 * above `file` at `node_modules/<name>`. Else `undefined`, such as for a file
 * of a linked workspace package.
 *
 * @example
 * packageDirectoryOf("/app/node_modules/react/cjs/react.js", "react"); // => "/app/node_modules/react"
 */
export function packageDirectoryOf(file: string, name: string): string | undefined {
	for (
		let directory = dirname(file);
		directory !== dirname(directory);
		directory = dirname(directory)
	) {
		if (directory.endsWith(`${sep}${join("node_modules", name)}`)) {
			// Why the real path: `findPackage` gives real paths, and the two must compare equal.
			return realpathSync(directory);
		}
	}
	return undefined;
}

/** Whether a `.node` file is in `directory`, outside its `node_modules`. */
function hasNodeFile(directory: string): boolean {
	return readdirSync(directory, { withFileTypes: true }).some((entry) =>
		entry.isDirectory()
			? entry.name !== "node_modules" && hasNodeFile(join(entry.parentPath, entry.name))
			: entry.name.endsWith(".node"),
	);
}

/**
 * Whether the package in `directory` loads a native addon: a `.node` file is
 * in the package, or in a package of its `dependencies` or
 * `optionalDependencies`. The second case finds a package that gets its addon
 * from a package for each platform, such as `oxc-parser` from
 * `@oxc-parser/binding-darwin-arm64`. Only the installed platform package is
 * there. `scans` keeps the result for each directory that the function
 * searched, so a call with the same map does not search a directory again.
 *
 * @example
 * isNativePackage("/app/node_modules/better-sqlite3"); // => true
 */
export function isNativePackage(directory: string, scans = new Map<string, boolean>()): boolean {
	const scan = (path: string): boolean => {
		const found = scans.get(path) ?? hasNodeFile(path);
		scans.set(path, found);
		return found;
	};
	return (
		scan(directory) ||
		dependencyNames(directory, ["dependencies", "optionalDependencies"]).some((name) => {
			const dependency = findPackage(name, directory);
			return dependency != null && scan(dependency);
		})
	);
}

/**
 * The `node_modules` directories where Node looks for a package that the
 * package at `destination` imports, nearest first, down to `target`.
 */
function lookupDirectories(destination: string, target: string): string[] {
	const directories: string[] = [];
	for (let directory = destination; ; directory = dirname(directory)) {
		if (basename(directory) !== "node_modules") {
			directories.push(join(directory, "node_modules"));
		}
		if (directory === dirname(target)) {
			return directories;
		}
	}
}

/**
 * Copies each package, whole, with the installed packages of its
 * `dependencies`, `optionalDependencies`, and `peerDependencies`, into the
 * `node_modules` directory `target`. Node then finds each package from a file
 * next to `target`, with no install. The copy follows symbolic links. A
 * dependency goes to the top of `target`. If another copy of that package is
 * nearer in the lookup path of the package that needs it, the dependency goes
 * into that package's own `node_modules`.
 *
 * @example
 * copyPackages(new Map([["oxc-parser", "/app/node_modules/oxc-parser"]]), "/app/build/server/node_modules");
 */
export function copyPackages(packages: ReadonlyMap<string, string>, target: string): void {
	// Why a map of destinations: a later lookup must know which copy is at each path.
	const sources = new Map<string, string>();
	const queue: string[] = [];
	const add = (destination: string, source: string) => {
		sources.set(destination, source);
		queue.push(destination);
	};
	for (const [name, source] of packages) {
		add(join(target, name), source);
	}
	// Why breadth first: a package places all its own dependencies before a dependency looks up
	// its own, so a later copy never hides an earlier lookup.
	for (const destination of queue) {
		const source = sources.get(destination) ?? "";
		cpSync(source, destination, {
			recursive: true,
			dereference: true,
			filter: (path) => path !== join(source, "node_modules"),
		});
		for (const name of dependencyNames(source, [
			"dependencies",
			"optionalDependencies",
			"peerDependencies",
		])) {
			const dependency = findPackage(name, source);
			const found = lookupDirectories(destination, target)
				.map((directory) => join(directory, name))
				.find((path) => sources.has(path));
			if (dependency != null && (found == null || sources.get(found) !== dependency)) {
				add(join(found == null ? target : join(destination, "node_modules"), name), dependency);
			}
		}
	}
}
