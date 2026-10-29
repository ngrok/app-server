import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The file under the client build that holds the headers each prerendered
 * response had at build time. It is a dotfile, so the static stages never
 * serve it.
 */
export const CAPTURED_HEADERS_FILE = ".headers.json";

/** The headers of each prerendered URL path. */
export type CapturedHeaders = Record<string, Record<string, string>>;

/**
 * The key for a URL path in {@link CapturedHeaders}: the path with no
 * trailing slash, so `/a/` and `/a` share headers. The root stays `/`.
 *
 * @example
 * capturedHeadersKey("/components/button/"); // => "/components/button"
 */
export function capturedHeadersKey(pathname: string): string {
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
 * Reads the captured headers of a client build. A build with no file has
 * none. A file in any other shape throws, so a bad build stops startup.
 */
export async function readCapturedHeaders(
	clientDirectory: string,
): Promise<ReadonlyMap<string, Record<string, string>>> {
	let text: string;
	try {
		text = await readFile(join(clientDirectory, CAPTURED_HEADERS_FILE), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return new Map();
		}
		throw error;
	}
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
		throw new Error(`${CAPTURED_HEADERS_FILE} must hold an object of header objects.`);
	}
	const captured = new Map<string, Record<string, string>>();
	for (const [path, headers] of Object.entries(parsed)) {
		if (!isStringRecord(headers)) {
			throw new Error(`${CAPTURED_HEADERS_FILE}: the headers for ${path} must be strings.`);
		}
		captured.set(path, headers);
	}
	return captured;
}
