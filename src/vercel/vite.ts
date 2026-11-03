import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { nodeFileTrace } from "@vercel/nft";
import { searchForWorkspaceRoot } from "vite";
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

/** Copies the file or the symbolic link at `from` to `to`. */
function copyEntry(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	if (lstatSync(from).isSymbolicLink()) {
		// Why keep links: pnpm links each package into `node_modules`, and Node resolves through them.
		rmSync(to, { force: true });
		symlinkSync(readlinkSync(from), to);
	} else {
		copyFileSync(from, to);
	}
}

/** The path of each file under `directory`, relative to it. */
function filesUnder(directory: string): string[] {
	if (!existsSync(directory)) {
		return [];
	}
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => !entry.isDirectory())
		.map((entry) => relative(directory, join(entry.parentPath, entry.name)));
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
			src: `^${escaped(prefix)}`,
			headers: prefix === ASSETS ? { ...cdnHeaders, "Cache-Control": IMMUTABLE } : cdnHeaders,
			continue: true,
		})),
	];
}

/** Writes `.vercel/output` (the Build Output API, version 3) for one build. */
async function writeOutput(
	{ root, clientDirectory, entryFile }: HostOutput,
	{ cdnPaths = [], cdnHeaders = {}, regions, memory, maxDuration }: VercelOptions,
): Promise<void> {
	const prefixes = [ASSETS, ...cdnPaths.filter((path) => path !== ASSETS)];
	const output = join(root, ".vercel/output");
	rmSync(output, { recursive: true, force: true });
	// Why the workspace root: in a monorepo, the app's packages are in the root's `node_modules`.
	const base = searchForWorkspaceRoot(root);
	const fromBase = (path: string): string => {
		const inside = relative(base, path);
		if (inside.startsWith("..") || isAbsolute(inside)) {
			throw new Error(`@ngrok/app-server/vercel needs ${path} inside the workspace root ${base}.`);
		}
		return inside;
	};
	const functionDirectory = join(output, "functions/index.func");
	const isCdnFile = (file: string): boolean =>
		prefixes.some((prefix) => `/${posix(file)}`.startsWith(prefix));

	for (const file of filesUnder(clientDirectory)) {
		const from = join(clientDirectory, file);
		if (!isCdnFile(file)) {
			copyEntry(from, join(functionDirectory, fromBase(from)));
		} else if (!basename(file).startsWith(".")) {
			// Why skip dotfiles, such as the gzip copies: the CDN sends each file that it has.
			copyEntry(from, join(output, "static", file));
		}
	}

	const functionFile = join(dirname(entryFile), FUNCTION_FILE);
	writeFileSync(
		functionFile,
		[
			`import { handler } from "@ngrok/app-server/vercel";`,
			`import { appServer } from ${JSON.stringify(`./${basename(entryFile)}`)};`,
			`export default handler(appServer);`,
			"",
		].join("\n"),
	);
	const { fileList } = await nodeFileTrace([functionFile], { base });
	const clientFromBase = `${fromBase(clientDirectory)}${sep}`;
	for (const file of fileList) {
		// Why skip the client build: the loop above copied what the function needs of it.
		if (!file.startsWith(clientFromBase)) {
			copyEntry(join(base, file), join(functionDirectory, file));
		}
	}
	writeFileSync(
		join(functionDirectory, ".vc-config.json"),
		`${JSON.stringify(
			{
				// Why the build's Node.js: the server build targets the Node.js that built it.
				runtime: `nodejs${process.versions.node.split(".")[0]}.x`,
				handler: posix(fromBase(functionFile)),
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
 *   each other request, with the server build, the rest of the client build,
 *   and the packages that the server imports.
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
		output: async (build) => writeOutput(build, options),
	};
}
