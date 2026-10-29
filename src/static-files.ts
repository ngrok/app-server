import { readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { Context } from "hono";
import { getMimeType } from "hono/utils/mime";
import type { AppServerEnv } from "./types.js";

/** A file under the client build that answers a request. */
export type StaticFile = {
	/** The absolute file path. */
	path: string;
	size: number;
	mtimeMs: number;
};

/**
 * Whether a URL path names a dotfile or goes through a dot directory.
 * `/.well-known/` stays reachable.
 */
function hasDotSegment(path: string): boolean {
	return path
		.split("/")
		.some(
			(segment, index) => segment.startsWith(".") && !(index === 1 && segment === ".well-known"),
		);
}

async function fileStats(path: string) {
	try {
		return await stat(path);
	} catch {
		return undefined;
	}
}

/**
 * Finds the file under `root` that answers a URL path. A directory answers
 * with its `index.html` and no redirect, so a prerendered page keeps its URL.
 * Dotfiles, encoded traversal, and paths outside `root` find nothing.
 *
 * @example
 * await findStaticFile("/app/build/client", "/components/button");
 * // => { path: "/app/build/client/components/button/index.html", size: 5120, mtimeMs: 1761652800000 }
 */
export async function findStaticFile(
	root: string,
	urlPath: string,
): Promise<StaticFile | undefined> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(urlPath);
	} catch {
		return undefined;
	}
	if (
		decoded.includes("\0") ||
		decoded.includes("\\") ||
		decoded.split("/").includes("..") ||
		hasDotSegment(decoded)
	) {
		return undefined;
	}
	const candidate = join(root, decoded);
	if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
		return undefined;
	}
	const stats = await fileStats(candidate);
	if (stats?.isFile()) {
		return { path: candidate, size: stats.size, mtimeMs: stats.mtimeMs };
	}
	if (stats?.isDirectory()) {
		const index = join(candidate, "index.html");
		const indexStats = await fileStats(index);
		if (indexStats?.isFile()) {
			return { path: index, size: indexStats.size, mtimeMs: indexStats.mtimeMs };
		}
	}
	return undefined;
}

/** The content type of a file, with the React Router and markdown types that `mime` lacks. */
function contentType(path: string): string {
	if (path.endsWith(".md")) {
		return "text/markdown; charset=utf-8";
	}
	if (path.endsWith(".data")) {
		return "text/x-script";
	}
	return getMimeType(path) ?? "application/octet-stream";
}

/** An ETag without its weak prefix, for the weak comparison that `If-None-Match` uses. */
function opaqueTag(etag: string): string {
	return etag.trim().replace(/^W\//, "");
}

/** Whether an `If-None-Match` header lists an ETag. */
function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
	return (
		ifNoneMatch?.split(",").some((candidate) => {
			const trimmed = candidate.trim();
			return trimmed === "*" || opaqueTag(trimmed) === opaqueTag(etag);
		}) ?? false
	);
}

/**
 * The response for a static file, with a weak ETag from its size and
 * modification time. A matching `If-None-Match` gets a 304, and `HEAD` gets
 * the headers only. `headers` replace the defaults, so a captured
 * `Content-Type` wins over the one from the file name.
 */
export async function staticResponse(
	context: Context<AppServerEnv>,
	file: StaticFile,
	headers: Readonly<Record<string, string>>,
): Promise<Response> {
	const etag = `W/"${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}"`;
	const responseHeaders = new Headers({ "Content-Type": contentType(file.path), ETag: etag });
	for (const [name, value] of Object.entries(headers)) {
		responseHeaders.set(name, value);
	}
	// Why the final header: `headers` can replace the ETag.
	if (matchesEtag(context.req.header("If-None-Match"), responseHeaders.get("ETag") ?? etag)) {
		responseHeaders.delete("Content-Type");
		return new Response(null, { status: 304, headers: responseHeaders });
	}
	if (context.req.method === "HEAD") {
		responseHeaders.set("Content-Length", String(file.size));
		return new Response(null, { headers: responseHeaders });
	}
	const body = await readFile(file.path);
	responseHeaders.set("Content-Length", String(body.byteLength));
	return new Response(body, { headers: responseHeaders });
}
