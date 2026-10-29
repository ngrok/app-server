import type { Context } from "hono";
import { getMimeType } from "hono/utils/mime";
import type { AppServerEnv, StaticFiles } from "./types.js";

/** A file under the client build that answers a request. */
export type StaticFile = {
	/** The URL path of the file, such as `/components/button/index.html`. */
	path: string;
	size: number;
	mtimeMs: number;
};

/** The content types that `mime` lacks and that no framework owns. */
const CORE_CONTENT_TYPES: Readonly<Record<string, string>> = {
	".md": "text/markdown; charset=utf-8",
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

/**
 * Finds the file in `files` that answers a decoded URL path, such as Hono's
 * `context.req.path`. A directory answers with its `index.html` and no
 * redirect, so a prerendered page keeps its URL. Dotfiles and paths that
 * leave the client build find nothing.
 *
 * Each file has one URL, because the headers for a file are keyed by that
 * URL. So `/a//b`, `/a/index.html`, and `/a%2Fb` find nothing. Hono decodes
 * the path but keeps an encoded `/` as `%2F`, so this function does not
 * decode it again.
 *
 * @example
 * await findStaticFile(files, "/components/button");
 * // => { path: "/components/button/index.html", size: 5120, mtimeMs: 1761652800000 }
 */
export async function findStaticFile(
	files: StaticFiles,
	path: string,
): Promise<StaticFile | undefined> {
	if (
		!path.startsWith("/") ||
		path.includes("\0") ||
		path.includes("\\") ||
		path.split("/").includes("..") ||
		path.includes("//") ||
		path.endsWith("/index.html") ||
		hasDotSegment(path)
	) {
		return undefined;
	}
	const info = await files.stat(path);
	if (info?.kind === "file") {
		return { path, size: info.size, mtimeMs: info.mtimeMs };
	}
	if (info?.kind === "directory") {
		const index = `${path.replace(/\/$/u, "")}/index.html`;
		const indexInfo = await files.stat(index);
		if (indexInfo?.kind === "file") {
			return { path: index, size: indexInfo.size, mtimeMs: indexInfo.mtimeMs };
		}
	}
	return undefined;
}

/** The content type of a file, by its extension. `contentTypes` win over `mime`. */
function contentType(path: string, contentTypes: Readonly<Record<string, string>>): string {
	const extension = /\.[^./]+$/u.exec(path)?.[0] ?? "";
	return (
		contentTypes[extension] ??
		CORE_CONTENT_TYPES[extension] ??
		getMimeType(path) ??
		"application/octet-stream"
	);
}

/** An ETag without its weak prefix, for the weak comparison that `If-None-Match` uses. */
function opaqueTag(etag: string): string {
	return etag.trim().replace(/^W\//u, "");
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

/** A weak ETag from a file's size, its modification time, and the request's `etagParts`. */
async function fileEtag(file: StaticFile, parts: readonly string[]): Promise<string> {
	const base = `${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}`;
	if (parts.length === 0) {
		return `W/"${base}"`;
	}
	// Why Web Crypto: each host has it, and the core imports no Node module.
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\0")));
	const hash = btoa(String.fromCodePoint(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.slice(0, 16);
	return `W/"${base}-${hash}"`;
}

/** What {@link staticResponse} needs besides the request. */
export type StaticResponseOptions = {
	files: StaticFiles;
	file: StaticFile;
	/** Headers that replace the defaults, so a captured `Content-Type` wins over the one from the file name. */
	headers: Readonly<Record<string, string>>;
	contentTypes: Readonly<Record<string, string>>;
};

/**
 * The response for a static file, with a weak ETag from its size,
 * modification time, and the request's `etagParts`. A matching
 * `If-None-Match` gets a 304, and `HEAD` gets the headers only.
 */
export async function staticResponse(
	context: Context<AppServerEnv>,
	{ files, file, headers, contentTypes }: StaticResponseOptions,
): Promise<Response> {
	const etag = await fileEtag(file, context.get("etagParts") ?? []);
	const responseHeaders = new Headers({
		"Content-Type": contentType(file.path, contentTypes),
		ETag: etag,
	});
	for (const [name, value] of Object.entries(headers)) {
		responseHeaders.set(name, value);
	}
	// Why the final header: `headers` can replace the ETag.
	if (matchesEtag(context.req.header("If-None-Match"), responseHeaders.get("ETag") ?? etag)) {
		responseHeaders.delete("Content-Type");
		return new Response(null, { status: 304, headers: responseHeaders });
	}
	responseHeaders.set("Content-Length", String(file.size));
	if (context.req.method === "HEAD") {
		return new Response(null, { headers: responseHeaders });
	}
	return new Response(await files.open(file.path), { headers: responseHeaders });
}
