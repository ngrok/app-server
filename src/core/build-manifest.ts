import type { StaticFiles } from "./types.js";

/**
 * The file under the client build that the Vite plugin writes during the
 * prerender pass. It is a dotfile, so the static stages never serve it.
 */
export const BUILD_MANIFEST_FILE = ".app-server.json";

/** What the Vite plugin records during the prerender pass. */
export type BuildManifest = {
	/** The URL paths that answered with a 2xx, sorted. */
	prerendered: string[];
	/** The headers of each prerendered file that is not an HTML document, by URL path. */
	headers: Record<string, Record<string, string>>;
};

/**
 * The key for a URL path in {@link BuildManifest}: the path with no trailing
 * slash, so `/a/` and `/a` share headers. The root stays `/`.
 *
 * @example
 * manifestKey("/components/button/"); // => "/components/button"
 */
export function manifestKey(pathname: string): string {
	const trimmed = pathname.replace(/\/+$/u, "");
	return trimmed === "" ? "/" : trimmed;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value != null &&
		!Array.isArray(value) &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

/**
 * Reads the build manifest of a client build. A build with no file has an
 * empty one. A file in any other shape throws, so a bad build stops startup.
 */
export async function readBuildManifest(files: StaticFiles): Promise<BuildManifest> {
	const path = `/${BUILD_MANIFEST_FILE}`;
	if ((await files.stat(path))?.kind !== "file") {
		return { prerendered: [], headers: {} };
	}
	const parsed: unknown = await new Response(await files.open(path)).json();
	if (
		typeof parsed !== "object" ||
		parsed == null ||
		!("prerendered" in parsed) ||
		!Array.isArray(parsed.prerendered) ||
		!parsed.prerendered.every((entry) => typeof entry === "string") ||
		!("headers" in parsed) ||
		typeof parsed.headers !== "object" ||
		parsed.headers == null
	) {
		throw new Error(
			`${BUILD_MANIFEST_FILE} must hold a "prerendered" list and a "headers" object.`,
		);
	}
	const headers: Record<string, Record<string, string>> = {};
	for (const [key, value] of Object.entries(parsed.headers)) {
		if (!isStringRecord(value)) {
			throw new Error(`${BUILD_MANIFEST_FILE}: the headers for ${key} must be strings.`);
		}
		headers[key] = value;
	}
	return { prerendered: parsed.prerendered, headers };
}
