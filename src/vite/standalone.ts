import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { nodeFileTrace } from "@vercel/nft";

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

/** A package that {@link copyPackages} copied, by the directory of its copy. */
export type CopiedPackage = {
	name: string;
	/** The directory that the package came from. */
	source: string;
	/** The directories of the copies of its dependencies. */
	dependencies: string[];
};

/**
 * Copies each package, whole, with the installed packages of its
 * `dependencies`, `optionalDependencies`, and `peerDependencies`, into the
 * `node_modules` directory `target`, except the packages in `omit`. Node then
 * finds each package from a file next to `target`, with no install. The copy
 * follows symbolic links. A dependency goes to the top of `target`. If another
 * copy of that package is nearer in the lookup path of the package that needs
 * it, the dependency goes into that package's own `node_modules`.
 *
 * @example
 * copyPackages(new Map([["oxc-parser", "/app/node_modules/oxc-parser"]]), "/app/build/server/node_modules");
 */
export function copyPackages(
	packages: ReadonlyMap<string, string>,
	target: string,
	{ omit = new Set() }: { omit?: ReadonlySet<string> } = {},
): Map<string, CopiedPackage> {
	// Why a map of destinations: a later lookup must know which copy is at each path.
	const copied = new Map<string, CopiedPackage>();
	const queue: (readonly [string, CopiedPackage])[] = [];
	const add = (destination: string, name: string, source: string) => {
		const copy: CopiedPackage = { name, source, dependencies: [] };
		copied.set(destination, copy);
		queue.push([destination, copy]);
	};
	for (const [name, source] of packages) {
		if (!omit.has(name)) {
			add(join(target, name), name, source);
		}
	}
	// Why breadth first: a package places all its own dependencies before a dependency looks up
	// its own, so a later copy never hides an earlier lookup.
	for (const [destination, copy] of queue) {
		const { source } = copy;
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
				.find((path) => copied.has(path));
			if (dependency != null && !omit.has(name)) {
				if (found == null || copied.get(found)?.source !== dependency) {
					const placed = join(found == null ? target : join(destination, "node_modules"), name);
					add(placed, name, dependency);
					copy.dependencies.push(placed);
				} else {
					copy.dependencies.push(found);
				}
			}
		}
	}
	return copied;
}

/** Each file under `directory`, except in a `node_modules` directory. */
function ownFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(entry.parentPath, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "node_modules" ? [] : ownFiles(path);
		}
		return [path];
	});
}

/** Removes each empty directory in `directory`, and `directory` when it is then empty. */
function removeEmptyDirectories(directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			removeEmptyDirectories(join(directory, entry.name));
		}
	}
	if (readdirSync(directory).length === 0) {
		rmSync(directory, { recursive: true });
	}
}

/**
 * The export conditions of each runtime that the server runs on, besides
 * `import`, `require`, and `default`. Why each: Bun and Deno take their own
 * entry of a package before its `node` entry.
 */
const RUNTIME_CONDITIONS = [["node"], ["bun", "node"], ["deno", "node"]];

/** Code that finds a file next to its own module in a way that `@vercel/nft` does not follow. */
const UNTRACED_OWN_FILE = /import\.meta\.(?:dirname|filename)\b/u;

/**
 * Whether the trace missed a file of a package, from the files of the
 * package that it found: a module that finds a file through
 * {@link UNTRACED_OWN_FILE}, or only a `package.json`, as for a
 * `require.resolve()` of a subpath in its `exports`.
 */
function missesFiles(loaded: readonly string[]): boolean {
	return (
		(loaded.length > 0 && loaded.every((file) => basename(file) === "package.json")) ||
		loaded.some(
			(file) => /\.[cm]?js$/u.test(file) && UNTRACED_OWN_FILE.test(readFileSync(file, "utf8")),
		)
	);
}

/**
 * Removes each file of a package in `copied` that the server build in
 * `serverDirectory` cannot load, as `@vercel/nft` traces it from each module
 * of the build. A package that no traced file is in goes away whole. Each
 * package for which `whole` is true, and each package that it depends on,
 * keeps each file. Why: a native package can load a library through the
 * system's loader, such as `sharp` loads libvips, and a trace cannot see it.
 * A package whose files the trace misses ({@link missesFiles}) keeps each
 * file too, with each package that it depends on.
 *
 * @example
 * await removeUntraced("/app/build/server", copied, (copy) => isNativePackage(copy.source));
 */
export async function removeUntraced(
	serverDirectory: string,
	copied: ReadonlyMap<string, CopiedPackage>,
	whole: (copy: CopiedPackage) => boolean,
): Promise<void> {
	const kept = new Set<string>();
	const keep = (destination: string) => {
		if (!kept.has(destination)) {
			kept.add(destination);
			for (const dependency of copied.get(destination)?.dependencies ?? []) {
				keep(dependency);
			}
		}
	};
	for (const [destination, copy] of copied) {
		if (whole(copy)) {
			keep(destination);
		}
	}
	if (kept.size === copied.size) {
		return;
	}
	const modules = ownFiles(serverDirectory).filter((file) => /\.[cm]?js$/u.test(file));
	// Why a cache: the traces share the parse of each module.
	const cache = {};
	const traces = await Promise.all(
		RUNTIME_CONDITIONS.map(async (conditions) =>
			nodeFileTrace(modules, { base: serverDirectory, mixedModules: true, conditions, cache }),
		),
	);
	const traced = new Set(
		traces.flatMap(({ fileList }) => [...fileList].map((file) => join(serverDirectory, file))),
	);
	const present = [...copied.keys()].filter((destination) => existsSync(destination));
	for (const destination of present) {
		if (
			!kept.has(destination) &&
			missesFiles(ownFiles(destination).filter((file) => traced.has(file)))
		) {
			keep(destination);
		}
	}
	for (const destination of present.filter((each) => !kept.has(each))) {
		const files = ownFiles(destination);
		const used = files.some((file) => traced.has(file));
		for (const file of files) {
			// Why each `package.json`: Node reads it to find the entry and the module type of a file.
			if (!traced.has(file) && !(used && basename(file) === "package.json")) {
				rmSync(file);
			}
		}
	}
	// Why the whole `node_modules`: a scope directory, such as `@resvg`, can be empty now too.
	removeEmptyDirectories(join(serverDirectory, "node_modules"));
}
