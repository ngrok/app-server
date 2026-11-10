// The step of `vercel()` that finds the prerendered pages that Vercel's content delivery network
// (CDN) can serve with no function. `vercel()` runs it in a child process after the build:
//
//   node vercel-pages.js <server entry> <static directory> <report file>
//
// Why a child process: the step starts the built server, and the build output must stay sync. A
// plugin's `setup` can also leave a socket or a timer, so the process exits when the step ends.
// Why no relative import: the build runs this file from `src` in the tests of this package.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** A prerendered path that the CDN serves, as `vercel()` writes it. */
export type CdnPageReport = {
	path: string;
	/**
	 * The URL path of the page's body under the static directory, such as
	 * `/0/index.html`. Why not the page's file: two paths can have one file,
	 * such as with `prerendered({ rewrite })`, and different bodies.
	 */
	file: string;
	answers: { present: readonly string[]; headers: Readonly<Record<string, string>> }[];
	twin?: string;
};

/** What the step found: the paths that the CDN serves, and why the function serves each other path. */
export type PagesReport = {
	cdn: CdnPageReport[];
	server: { path: string; reason: string }[];
};

/** The part of the server entry that this step calls. */
type Entry = {
	staticPages: () => AsyncIterable<
		{ path: string } & (
			| {
					cdn: { file: string; body: Uint8Array; answers: CdnPageReport["answers"]; twin?: string };
			  }
			| { reason: string }
		)
	>;
	stopPlugins: () => Promise<void>;
};

function isEntry(value: unknown): value is Entry {
	return (
		typeof value === "object" &&
		value != null &&
		"staticPages" in value &&
		typeof value.staticPages === "function" &&
		"stopPlugins" in value &&
		typeof value.stopPlugins === "function"
	);
}

/**
 * Writes the body of each page that the CDN can serve to `staticDirectory`,
 * at the path of its file, and the {@link PagesReport} to `reportFile`.
 *
 * @example
 * await writePages("build/server/app-server.js", ".vercel/output/static/_app-server/pages", "pages.json");
 */
export async function writePages(
	entryFile: string,
	staticDirectory: string,
	reportFile: string,
): Promise<void> {
	const module: unknown = await import(pathToFileURL(entryFile).href);
	const entry =
		typeof module === "object" && module != null && "appServer" in module
			? module.appServer
			: undefined;
	if (!isEntry(entry)) {
		throw new Error(`${entryFile} exports no appServer of this version of @ngrok/app-server.`);
	}
	const report: PagesReport = { cdn: [], server: [] };
	try {
		for await (const page of entry.staticPages()) {
			if ("cdn" in page) {
				const { body, answers, twin } = page.cdn;
				const file = `/${report.cdn.length}/${basename(page.cdn.file)}`;
				const target = join(staticDirectory, file);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, body);
				report.cdn.push({ path: page.path, file, answers, ...(twin == null ? {} : { twin }) });
			} else {
				report.server.push({ path: page.path, reason: page.reason });
			}
		}
	} finally {
		await entry.stopPlugins();
	}
	mkdirSync(dirname(reportFile), { recursive: true });
	writeFileSync(reportFile, JSON.stringify(report));
}

if (import.meta.main) {
	const [entryFile = "", staticDirectory = "", reportFile = ""] = process.argv.slice(2);
	await writePages(entryFile, staticDirectory, reportFile);
	// oxlint-disable-next-line unicorn/no-process-exit -- a plugin's `setup` can leave a socket or a timer that keeps the process alive.
	process.exit(0);
}
