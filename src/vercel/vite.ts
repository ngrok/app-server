import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hasDotSegment } from "../core/static-files.js";
import type { HostBuild, HostOutput } from "../vite/index.js";
import type { CdnPageReport, PagesReport } from "./pages.js";

/** Options for {@link vercel}. */
export type VercelOptions = {
	/**
	 * More URL path prefixes of the client build that Vercel's CDN serves,
	 * such as `["/blog-assets/"]`. Each starts and ends with `/`. The URL path
	 * of Vite's `build.assetsDir`, `/assets/` by default, is always one. Their
	 * files skip the pipeline, and the function does not carry them.
	 */
	cdnPaths?: readonly string[];
	/** Headers for each file under `cdnPaths` and Vite's `build.assetsDir`, such as CORS headers. */
	cdnHeaders?: Readonly<Record<string, string>>;
	/**
	 * Which prerendered pages the CDN serves, with no function. After the
	 * build, `vercel()` starts the server build once and sends each
	 * prerendered path through the pipeline as an anonymous client. The CDN
	 * serves a page when its answer is a public 200 from its file, and the
	 * same for another host, client address, and query. The CDN then sends
	 * the pipeline's body and headers. The function serves each other page,
	 * and the CDN never keeps its answer. `false` keeps each page in the
	 * function. A function keeps each path that it refuses in the function,
	 * such as a page whose answer depends on one query key.
	 * @default true
	 */
	cdnPages?: boolean | ((path: string) => boolean);
	/** The Vercel regions of the function, such as `["iad1"]`. @default the project's */
	regions?: readonly string[];
	/** The memory of the function, in MB. @default the project's */
	memory?: number;
	/**
	 * The longest time that a request runs, in seconds. It applies to each
	 * request, because one function serves each route. A route module's
	 * `config` export does nothing. @default the project's
	 */
	maxDuration?: number;
};

const IMMUTABLE = "public, max-age=31536000, immutable";

/** The most routes of a deployment. See https://vercel.com/docs/limits. */
const ROUTE_LIMIT = 2048;

/**
 * The URL path under `static/` of the bodies of the pages that the CDN
 * serves. A route sends a request for it to the function, so a page has one
 * URL.
 */
const PAGES = "/_app-server/pages";

/**
 * The script that finds the pages that the CDN serves. Why the source in a
 * `.ts` module: the tests of this package run the source, and Node.js runs a
 * `.ts` file with no import of its own.
 */
const PAGES_SCRIPT = fileURLToPath(
	new URL(import.meta.url.endsWith(".ts") ? "./pages.ts" : "./vercel-pages.js", import.meta.url),
);

/** A case-insensitive pattern for `text/markdown`, in the regular expression syntax of any engine. */
const MARKDOWN = "text/markdown".replaceAll(
	/[a-z]/gu,
	(letter) => `[${letter}${letter.toUpperCase()}]`,
);

/** The variable that gives the function the time of the build, in milliseconds. */
const BUILT_AT = "APP_SERVER_BUILT_AT";

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
 * whose target can be in the other part. Why the inodes of the parents: a
 * link to a parent directory must not make the walk endless.
 */
function filesUnder(
	directory: string,
	under = "",
	parents: ReadonlySet<string> = new Set(),
): string[] {
	const stats = statSync(join(directory, under), { throwIfNoEntry: false });
	if (stats == null) {
		return [];
	}
	if (!stats.isDirectory()) {
		return [under];
	}
	const inode = `${stats.dev}:${stats.ino}`;
	if (parents.has(inode)) {
		return [];
	}
	const inside = new Set(parents).add(inode);
	return readdirSync(join(directory, under)).flatMap((name) =>
		filesUnder(directory, join(under, name), inside),
	);
}

/**
 * The `.vercel/output` routes: a CDN file gets its headers, and each other
 * request goes to the function. A file under `assetsPath` also gets the
 * immutable cache. Why the `hit` phase: a CDN path with no file goes to the
 * function, whose `no-store` 404 must not get the immutable cache.
 */
function routes(
	prefixes: readonly string[],
	{
		assetsPath,
		cdnHeaders,
		pages,
	}: {
		assetsPath: string;
		cdnHeaders: Readonly<Record<string, string>>;
		pages: readonly CdnPageReport[];
	},
) {
	return [
		...(pages.length === 0 ? [] : [{ src: `^${escaped(PAGES)}(?:/.*)?$`, dest: "/index" }]),
		...pages.flatMap((page) => pageRoutes(page)),
		{ handle: "filesystem" },
		{ src: "^/(.*)$", dest: "/index" },
		{ handle: "hit" },
		...prefixes.map((prefix) => ({
			// Why `.*$`: Vercel adds `$` to a pattern that has none.
			src: `^${escaped(prefix)}.*$`,
			headers: prefix === assetsPath ? { ...cdnHeaders, "Cache-Control": IMMUTABLE } : cdnHeaders,
			continue: true,
		})),
	];
}

/**
 * The routes of one page that the CDN serves: one for each case of the
 * presence headers, with the headers of that case. Why only GET and HEAD: the
 * function answers the other methods, such as a form's POST. Why the
 * function for a request that names `text/markdown`: it negotiates the twin.
 */
function pageRoutes({ path, file, answers, twin }: CdnPageReport) {
	const src = `^${escaped(path)}$`;
	const names = [...new Set(answers.flatMap(({ present }) => present))];
	return [
		...(twin == null
			? []
			: [
					{
						src,
						has: [{ type: "header", key: "accept", value: { re: MARKDOWN } }],
						dest: "/index",
					},
				]),
		...answers.map(({ present, headers }) => {
			const missing = names.filter((name) => !present.includes(name));
			return {
				src,
				caseSensitive: true,
				methods: ["GET", "HEAD"],
				...(present.length === 0 ? {} : { has: present.map((key) => ({ type: "header", key })) }),
				...(missing.length === 0
					? {}
					: { missing: missing.map((key) => ({ type: "header", key })) }),
				headers,
				dest: `${PAGES}${file}`,
			};
		}),
	];
}

/**
 * Finds the pages that the CDN serves ({@link VercelOptions.cdnPages}), and
 * writes their bodies under `static/`.
 */
function findCdnPages(
	entryFile: string,
	output: string,
	{
		cdnPages,
		routeBudget,
	}: { cdnPages: NonNullable<VercelOptions["cdnPages"]>; routeBudget: number },
): PagesReport {
	if (cdnPages === false) {
		return { cdn: [], server: [] };
	}
	const pagesDirectory = join(output, "static", PAGES);
	const reportFile = join(output, "pages.json");
	try {
		execFileSync(process.execPath, [PAGES_SCRIPT, entryFile, pagesDirectory, reportFile], {
			stdio: "inherit",
			env: { ...process.env, NODE_ENV: "production" },
		});
	} catch (error) {
		throw new Error(
			"@ngrok/app-server/vercel could not start the server build to find the prerendered pages that the CDN can serve. Give the build the environment of the app, or set `vercel({ cdnPages: false })`.",
			{ cause: error },
		);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the step of this package wrote the file.
	const report = JSON.parse(readFileSync(reportFile, "utf8")) as PagesReport;
	rmSync(reportFile);
	const pages: PagesReport = { cdn: [], server: [...report.server] };
	let routeCount = 0;
	for (const page of report.cdn) {
		const count = pageRoutes(page).length;
		let reason: string | undefined;
		if (cdnPages !== true && !cdnPages(page.path)) {
			reason = "`cdnPages` keeps it in the function";
		} else if (routeCount + count > routeBudget) {
			reason = `the CDN routes of the pages reach Vercel's limit of ${ROUTE_LIMIT} routes`;
		}
		if (reason == null) {
			pages.cdn.push(page);
			routeCount += count;
		} else {
			rmSync(join(pagesDirectory, page.file));
			pages.server.push({ path: page.path, reason });
		}
	}
	return pages;
}

/** Writes the paths that the function serves, and why, so the build log shows them. */
function reportPages({ cdn, server }: PagesReport): void {
	const shown = server.slice(0, 20);
	process.stdout.write(
		[
			`@ngrok/app-server/vercel: the CDN serves ${cdn.length} prerendered paths, and the function serves ${server.length}.`,
			...shown.map(({ path, reason }) => `  ${path}: ${reason}`),
			...(server.length > shown.length ? [`  and ${server.length - shown.length} more`] : []),
			"",
		].join("\n"),
	);
}

/** Writes `.vercel/output` (the Build Output API, version 3) for one build. */
function writeOutput(
	{ root, clientDirectory, entryFile, assetsPath }: HostOutput,
	{ cdnPaths = [], cdnHeaders = {}, cdnPages = true, regions, memory, maxDuration }: VercelOptions,
): void {
	const prefixes = [assetsPath, ...cdnPaths.filter((path) => path !== assetsPath)];
	const output = join(root, ".vercel/output");
	rmSync(output, { recursive: true, force: true });
	const pages = findCdnPages(entryFile, output, {
		cdnPages,
		// Why one less: the route that sends a request for a page's body to the function.
		routeBudget: ROUTE_LIMIT - routes(prefixes, { assetsPath, cdnHeaders, pages: [] }).length - 1,
	});
	reportPages(pages);
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
		// Why the function keeps the file of a page that the CDN serves: a request that no page route
		// matches, such as the other trailing slash form, or a markdown request, reaches the function.
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
	cpSync(serverDirectory, join(functionDirectory, fromRoot(serverDirectory)), {
		recursive: true,
		// Why: a link that keeps its target can point at the build machine.
		dereference: true,
		// Why: the client build can be inside the server build, and the loop above copied its part.
		filter: (path) => path !== clientDirectory,
	});
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
				// Why: the deploy gives each file of the function one fixed time, and the ETag of a file
				// reads its time. See `host` in `@ngrok/app-server/vercel`.
				environment: { [BUILT_AT]: String(Date.now()) },
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
		`${JSON.stringify({ version: 3, routes: routes(prefixes, { assetsPath, cdnHeaders, pages: pages.cdn }) }, null, "\t")}\n`,
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
 * - `static/`: the files of Vite's `build.assetsDir` (`/assets/` by default)
 *   and the other `cdnPaths`. The CDN serves them, and each file of
 *   `build.assetsDir` gets a one-year immutable cache. It also holds the
 *   prerendered pages that the CDN serves. See `cdnPages`.
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
