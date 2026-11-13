import type { StaticFiles } from "./types.js";

/**
 * The file under the client build that the Vite plugin writes after the
 * client build and again after the prerender pass. It is a dotfile, so the
 * static stages never serve it.
 */
export const BUILD_MANIFEST_FILE = ".app-server.json";

/**
 * The file name of the server entry in the server build. Each host gets this
 * name, and `app-server serve` looks for it.
 */
export const SERVER_ENTRY_FILE = "app-server.js";

/** The URL path of the hashed files of a build that records none: Vite's default `build.assetsDir`. */
export const DEFAULT_ASSETS_PATH = "/assets/";

/** What the Vite plugin records about the client build. */
export type BuildManifest = {
	/**
	 * The ID of the client build: a hash of the files that the client build
	 * writes. The `buildId` plugin sends it by default.
	 */
	buildId?: string;
	/**
	 * The URL path of Vite's `build.assetsDir`, such as `/assets/`. It starts
	 * and ends with `/`. The `assets` plugin serves its files with a one-year
	 * immutable cache.
	 */
	assetsPath?: string;
	/** The URL paths that answered with a 2xx, sorted. */
	prerendered: string[];
	/** The headers of each prerendered file that is not an HTML document, by URL path. */
	headers: Record<string, Record<string, string>>;
	/**
	 * The base64 `SHA-256` of each inline script of each HTML file in the client
	 * build, by the file's URL path, such as `/about/index.html`. A CSP trusts
	 * the scripts of a prerendered page by these hashes.
	 */
	scriptHashes: Record<string, string[]>;
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

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** The `buildId` of a parsed manifest, which can have none. A value that is not a string throws. */
function buildIdOf(manifest: object): Pick<BuildManifest, "buildId"> {
	if (!("buildId" in manifest)) {
		return {};
	}
	if (typeof manifest.buildId !== "string") {
		throw new TypeError(`${BUILD_MANIFEST_FILE}: the "buildId" must be a string.`);
	}
	return { buildId: manifest.buildId };
}

/** The `assetsPath` of a parsed manifest, which can have none. A value that is not a URL path prefix throws. */
function assetsPathOf(manifest: object): Pick<BuildManifest, "assetsPath"> {
	if (!("assetsPath" in manifest)) {
		return {};
	}
	const { assetsPath } = manifest;
	if (
		typeof assetsPath !== "string" ||
		assetsPath === "/" ||
		!assetsPath.startsWith("/") ||
		!assetsPath.endsWith("/")
	) {
		throw new TypeError(
			`${BUILD_MANIFEST_FILE}: the "assetsPath" must be a URL path that starts and ends with "/".`,
		);
	}
	return { assetsPath };
}

/**
 * Reads the build manifest of a client build. A build with no file has an
 * empty one. A file that is not JSON, or one in any other shape, throws, so a
 * bad build stops startup.
 */
export async function readBuildManifest(files: StaticFiles): Promise<BuildManifest> {
	const path = `/${BUILD_MANIFEST_FILE}`;
	if ((await files.stat(path))?.kind !== "file") {
		return { prerendered: [], headers: {}, scriptHashes: {} };
	}
	const parsed: unknown = await new Response(await files.open(path))
		.json()
		.catch((error: unknown) => {
			throw new Error(
				`The server cannot read ${BUILD_MANIFEST_FILE} as JSON. Build the app again.`,
				{
					cause: error,
				},
			);
		});
	if (
		typeof parsed !== "object" ||
		parsed == null ||
		!("prerendered" in parsed) ||
		!isStringList(parsed.prerendered) ||
		!("headers" in parsed) ||
		typeof parsed.headers !== "object" ||
		parsed.headers == null ||
		!("scriptHashes" in parsed) ||
		typeof parsed.scriptHashes !== "object" ||
		parsed.scriptHashes == null
	) {
		throw new Error(
			`${BUILD_MANIFEST_FILE} must hold a "prerendered" list and the "headers" and "scriptHashes" objects.`,
		);
	}
	const headers: Record<string, Record<string, string>> = {};
	for (const [key, value] of Object.entries(parsed.headers)) {
		if (!isStringRecord(value)) {
			throw new Error(`${BUILD_MANIFEST_FILE}: the headers for ${key} must be strings.`);
		}
		headers[key] = value;
	}
	const scriptHashes: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(parsed.scriptHashes)) {
		if (!isStringList(value)) {
			throw new Error(`${BUILD_MANIFEST_FILE}: the script hashes for ${key} must be strings.`);
		}
		scriptHashes[key] = value;
	}
	return {
		...buildIdOf(parsed),
		...assetsPathOf(parsed),
		prerendered: parsed.prerendered,
		headers,
		scriptHashes,
	};
}
