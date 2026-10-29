import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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

async function fileStats(path: string): Promise<Stats | undefined> {
	return stat(path).catch(() => undefined);
}

/**
 * Finds the file under `root` that answers a decoded URL path, such as
 * Hono's `context.req.path`. A directory answers with its `index.html` and no
 * redirect, so a prerendered page keeps its URL. Dotfiles and paths outside
 * `root` find nothing.
 *
 * Each file has one URL, because the headers for a file are keyed by that
 * URL. So `/a//b`, `/a/index.html`, and `/a%2Fb` find nothing. Hono decodes
 * the path but keeps an encoded `/` as `%2F`, so this function does not
 * decode it again.
 *
 * @example
 * await findStaticFile("/app/build/client", "/components/button");
 * // => { path: "/app/build/client/components/button/index.html", size: 5120, mtimeMs: 1761652800000 }
 */
export async function findStaticFile(root: string, path: string): Promise<StaticFile | undefined> {
	if (
		path.includes("\0") ||
		path.includes("\\") ||
		path.split("/").includes("..") ||
		path.includes("//") ||
		path.endsWith("/index.html") ||
		hasDotSegment(path)
	) {
		return undefined;
	}
	const candidate = join(root, path);
	if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
		return undefined;
	}
	const stats = await fileStats(candidate);
	if (stats?.isFile() === true) {
		return { path: candidate, size: stats.size, mtimeMs: stats.mtimeMs };
	}
	if (stats?.isDirectory() === true) {
		const index = join(candidate, "index.html");
		const indexStats = await fileStats(index);
		if (indexStats?.isFile() === true) {
			return { path: index, size: indexStats.size, mtimeMs: indexStats.mtimeMs };
		}
	}
	return undefined;
}

/**
 * A file's bytes, one chunk for each pull, so a slow client holds one chunk,
 * not the whole file. The handle closes at the end, on an error, or on cancel.
 */
function fileStream(handle: FileHandle): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { bytesRead, buffer } = await handle.read({ buffer: new Uint8Array(65_536) });
				if (bytesRead === 0) {
					await handle.close();
					controller.close();
				} else {
					controller.enqueue(buffer.subarray(0, bytesRead));
				}
			} catch (error) {
				await handle.close();
				throw error;
			}
		},
		cancel: async () => handle.close(),
	});
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
function fileEtag(file: StaticFile, parts: readonly string[]): string {
	const base = `${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}`;
	if (parts.length === 0) {
		return `W/"${base}"`;
	}
	const hash = createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 16);
	return `W/"${base}-${hash}"`;
}

/**
 * The response for a static file, with a weak ETag from its size,
 * modification time, and the request's `etagParts`. A matching
 * `If-None-Match` gets a 304, and `HEAD` gets the headers only. `headers`
 * replace the defaults, so a captured `Content-Type` wins over the one from
 * the file name.
 */
export async function staticResponse(
	context: Context<AppServerEnv>,
	file: StaticFile,
	headers: Readonly<Record<string, string>>,
): Promise<Response> {
	const etag = fileEtag(file, context.get("etagParts") ?? []);
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
	responseHeaders.set("Content-Length", String(file.size));
	return new Response(fileStream(await open(file.path)), { headers: responseHeaders });
}
