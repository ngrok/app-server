import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { hasDotSegment } from "../core/static-files.js";
import type { HostBuild, HostOutput } from "../vite/index.js";

/** Options for {@link vercel}. */
export type VercelOptions = {
	/**
	 * More URL path prefixes of the client build that Vercel's CDN serves,
	 * such as `["/blog-assets/"]`. Each starts and ends with `/`. `/assets/`
	 * is always one. Their files skip the pipeline, and the function does not
	 * carry them.
	 */
	cdnPaths?: readonly string[];
	/** Headers for each file that the CDN serves, such as CORS headers. */
	cdnHeaders?: Readonly<Record<string, string>>;
	/** The Vercel regions of the function, such as `["iad1"]`. @default the project's */
	regions?: readonly string[];
	/** The memory of the function, in MB. @default the project's */
	memory?: number;
	/** The longest time that a request runs, in seconds. @default the project's */
	maxDuration?: number;
};

/** The hashed files of the client build. Their names change with their content. */
const ASSETS = "/assets/";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** The function's file, next to the server entry. */
const FUNCTION_FILE = "vercel-function.js";

/** A path with `/` separators, as Vercel's config reads it. */
function posix(path: string): string {
	return path.split(sep).join("/");
}

/** A regular expression source that matches `text` as it is. */
function escaped(text: string): string {
	return text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

/** Copies the file at `from` to `to`, and makes the directories of `to`. */
function copyFile(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(from, to);
}

/**
 * The path of each file under `directory`, relative to it. Why follow links:
 * the CDN and the function each get a copy of the linked file, not a link
 * whose target can be in the other part.
 */
function filesUnder(directory: string, under = ""): string[] {
	if (!existsSync(directory)) {
		return [];
	}
	return readdirSync(join(directory, under)).flatMap((name) => {
		const path = join(under, name);
		return statSync(join(directory, path)).isDirectory() ? filesUnder(directory, path) : [path];
	});
}

/**
 * The `.vercel/output` routes: a CDN file gets its headers, and each other
 * request goes to the function. Why the `hit` phase: a CDN path with no file
 * goes to the function, whose `no-store` 404 must not get the immutable cache.
 */
function routes(prefixes: readonly string[], cdnHeaders: Readonly<Record<string, string>>) {
	return [
		{ handle: "filesystem" },
		{ src: "^/(.*)$", dest: "/index" },
		{ handle: "hit" },
		...prefixes.map((prefix) => ({
			// Why `.*$`: Vercel adds `$` to a pattern that has none.
			src: `^${escaped(prefix)}.*$`,
			headers: prefix === ASSETS ? { ...cdnHeaders, "Cache-Control": IMMUTABLE } : cdnHeaders,
			continue: true,
		})),
	];
}

/** Writes `.vercel/output` (the Build Output API, version 3) for one build. */
function writeOutput(
	{ root, clientDirectory, entryFile }: HostOutput,
	{ cdnPaths = [], cdnHeaders = {}, regions, memory, maxDuration }: VercelOptions,
): void {
	const prefixes = [ASSETS, ...cdnPaths.filter((path) => path !== ASSETS)];
	const output = join(root, ".vercel/output");
	rmSync(output, { recursive: true, force: true });
	const fromRoot = (path: string): string => {
		const inside = relative(root, path);
		if (inside.startsWith("..") || isAbsolute(inside)) {
			throw new Error(`@ngrok/app-server/vercel needs ${path} inside the Vite root ${root}.`);
		}
		return inside;
	};
	const functionDirectory = join(output, "functions/index.func");
	const isCdnFile = (file: string): boolean =>
		prefixes.some((prefix) => `/${posix(file)}`.startsWith(prefix));

	for (const file of filesUnder(clientDirectory)) {
		const from = join(clientDirectory, file);
		if (!isCdnFile(file)) {
			copyFile(from, join(functionDirectory, fromRoot(from)));
		} else if (!hasDotSegment(`/${posix(file)}`)) {
			// Why the static stages' check: the CDN sends each file that it has, and the static stages
			// send no dotfile, such as a compressed copy, and no file in a dot directory.
			copyFile(from, join(output, "static", file));
		}
	}

	// Why the whole server build: it runs with no install, and it keeps the client build's path.
	const serverDirectory = dirname(entryFile);
	const functionFile = join(serverDirectory, FUNCTION_FILE);
	cpSync(serverDirectory, join(functionDirectory, fromRoot(serverDirectory)), { recursive: true });
	writeFileSync(
		join(functionDirectory, fromRoot(functionFile)),
		[
			`import { appServer, hostModule } from ${JSON.stringify(`./${basename(entryFile)}`)};`,
			`export default hostModule.handler(appServer);`,
			"",
		].join("\n"),
	);
	writeFileSync(
		join(functionDirectory, ".vc-config.json"),
		`${JSON.stringify(
			{
				// Why the build's Node.js: the server build targets the Node.js that built it.
				runtime: `nodejs${process.versions.node.split(".")[0]}.x`,
				handler: posix(fromRoot(functionFile)),
				launcherType: "Nodejs",
				supportsResponseStreaming: true,
				...(regions == null ? {} : { regions }),
				...(memory == null ? {} : { memory }),
				...(maxDuration == null ? {} : { maxDuration }),
			},
			null,
			"\t",
		)}\n`,
	);
	writeFileSync(
		join(output, "config.json"),
		`${JSON.stringify({ version: 3, routes: routes(prefixes, cdnHeaders) }, null, "\t")}\n`,
	);
}

/** Throws for a CDN path that is not a URL path prefix, so the config fails, not the deploy. */
function checkCdnPaths(paths: readonly string[]): void {
	for (const path of paths) {
		if (!path.startsWith("/") || !path.endsWith("/") || path === "/" || path.includes("..")) {
			throw new Error(
				`Each cdnPaths entry is a URL path prefix that starts and ends with "/", such as "/blog-assets/", not ${JSON.stringify(path)}.`,
			);
		}
	}
}

/**
 * The build side of the vercel host. After the build, it writes
 * `.vercel/output` in the Vite root, for `vercel deploy --prebuilt`:
 *
 * - `static/`: the files under `/assets/` and the other `cdnPaths`. The CDN
 *   serves them, and each file under `/assets/` gets a one-year immutable
 *   cache.
 * - `functions/index.func/`: one Node.js function that runs the pipeline for
 *   each other request, with the whole server build and the rest of the
 *   client build.
 *
 * @example
 * appServer({ host: vercel() });
 */
export function vercel(options: VercelOptions = {}): HostBuild {
	checkCdnPaths(options.cdnPaths ?? []);
	return {
		name: "vercel",
		runtimeModule: "@ngrok/app-server/vercel",
		entryFileName: "app-server.js",
		output: (build) => {
			writeOutput(build, options);
		},
	};
}
