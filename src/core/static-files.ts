import type { Context } from "hono";
import { getMimeType } from "hono/utils/mime";
import { COPY_ENCODINGS, copyPath, forbidsTransform, preferredEncoding } from "./compression.js";
import type { Encoding } from "./compression.js";
import { hookedHeaders } from "./header-hook.js";
import type { AppServerEnv, ByteRange, StaticFiles } from "./types.js";
import { withVary } from "./vary.js";

/** A file under the client build that answers a request. */
export type StaticFile = {
	/** The URL path of the file, such as `/components/button/index.html`. */
	path: string;
	size: number;
	mtimeMs: number;
};

/** The content types that `mime` lacks and that no framework owns. */
const CORE_CONTENT_TYPES: Readonly<Record<string, string>> = {
	".atom": "application/atom+xml",
	".md": "text/markdown; charset=utf-8",
	".pem": "application/x-pem-file",
	".rss": "application/rss+xml",
	".sh": "application/x-sh",
	// Why `text/yaml`: a browser shows a text type, and `express.static` sends it.
	".yaml": "text/yaml; charset=utf-8",
	".yml": "text/yaml; charset=utf-8",
};

/**
 * A segment that starts with a dot: one after the first segment, or a first
 * segment that is not `.well-known`. Why an expression: a `split` makes an
 * array and a string for each segment of each request path.
 */
const DOT_SEGMENT = /(?!^)\/\.|^\/\.(?!well-known(?:\/|$))/u;

/**
 * Whether a URL path, which starts with `/`, names a dotfile or goes through
 * a dot directory, `.` and `..` included. `/.well-known/` stays reachable.
 *
 * @example
 * hasDotSegment("/assets/.private/key.json"); // => true
 * hasDotSegment("/.well-known/security.txt"); // => false
 */
export function hasDotSegment(path: string): boolean {
	return DOT_SEGMENT.test(path);
}

/**
 * Whether a decoded URL path, such as Hono's `context.req.path`, can name a
 * file of the client build. Dotfiles, paths that leave the client build, and
 * a second URL for a file, such as `/a//b` or `/a/index.html`, cannot.
 *
 * @example
 * isFilePath("/docs/button"); // => true
 * isFilePath("/docs/../.env"); // => false
 */
export function isFilePath(path: string): boolean {
	return (
		path.startsWith("/") &&
		!path.includes("\0") &&
		!path.includes("\\") &&
		!path.includes("//") &&
		!path.endsWith("/index.html") &&
		!hasDotSegment(path)
	);
}

/**
 * Finds the file in `files` that answers a decoded URL path, such as Hono's
 * `context.req.path`. A directory answers with its `index.html` and no
 * redirect, so a prerendered page keeps its URL. A path that fails
 * `isFilePath` finds nothing.
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
	if (!isFilePath(path)) {
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
export function contentType(path: string, contentTypes: Readonly<Record<string, string>>): string {
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

/**
 * The last `etagParts` and their hash. Why one entry: each request has the
 * same parts for the life of the process.
 */
let lastParts: { key: string; hash: string } | undefined;

/** A short hash of the request's `etagParts`. */
async function partsHash(parts: readonly string[]): Promise<string> {
	const key = parts.join("\0");
	if (lastParts?.key === key) {
		return lastParts.hash;
	}
	// Why Web Crypto: each host has it, and the core imports no Node module.
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
	const hash = btoa(String.fromCodePoint(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.slice(0, 16);
	lastParts = { key, hash };
	return hash;
}

/**
 * A weak ETag from a file's size, its modification time, the request's
 * `etagParts`, and the encoding of the body. Why the encoding: after a 304,
 * a cache that holds more than one encoding of the file picks the stored
 * response by its ETag (RFC 9111, section 4.3.4).
 */
async function fileEtag(
	file: StaticFile,
	parts: readonly string[],
	encoding: Encoding | undefined,
): Promise<string> {
	const tag = [
		file.size.toString(16),
		Math.trunc(file.mtimeMs).toString(16),
		...(parts.length === 0 ? [] : [await partsHash(parts)]),
		...(encoding == null ? [] : [encoding]),
	];
	return `W/"${tag.join("-")}"`;
}

/**
 * The byte range that a `Range` header asks for in a file of `size` bytes.
 * It gives `"unsatisfiable"` for a range that starts after the end of the
 * file, and `undefined` for a header to ignore: a header that is not valid,
 * or one with more than one range.
 *
 * @example
 * byteRange("bytes=-100", 1000); // => { start: 900, end: 999 }
 */
export function byteRange(header: string, size: number): ByteRange | "unsatisfiable" | undefined {
	const groups = /^bytes=(?<first>\d*)-(?<last>\d*)$/u.exec(header.trim())?.groups;
	const first = groups?.first ?? "";
	const last = groups?.last ?? "";
	if (first === "" && last === "") {
		return undefined;
	}
	if (first === "") {
		const suffix = Number(last);
		return suffix === 0 || size === 0
			? "unsatisfiable"
			: { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(first);
	const end = last === "" ? Number.POSITIVE_INFINITY : Number(last);
	if (end < start) {
		return undefined;
	}
	return start >= size ? "unsatisfiable" : { start, end: Math.min(end, size - 1) };
}

/** Why these caps: they hold the hashed chunks of a typical app, and they limit the memory of each process. */
const KEPT_FILE_BYTES = 256 * 1024;
const KEPT_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * `files` that keep the bytes of each small file in memory after the first
 * read, up to {@link KEPT_TOTAL_BYTES} in all. Use it only for files that
 * do not change while the server runs, such as a `StaticFiles.snapshot()`.
 *
 * @example
 * const files = keptFiles(await nodeFiles("build/client").snapshot());
 */
export function keptFiles(files: StaticFiles): StaticFiles {
	const kept = new Map<string, Promise<Uint8Array>>();
	let total = 0;
	return {
		stat: files.stat,
		open: async (path, range) => {
			let bytes = kept.get(path);
			const info = bytes == null ? await files.stat(path) : undefined;
			// Why again: another request can start to read the file during the `stat`.
			bytes ??= kept.get(path);
			if (bytes == null) {
				if (
					info?.kind !== "file" ||
					info.size > KEPT_FILE_BYTES ||
					total + info.size > KEPT_TOTAL_BYTES
				) {
					return files.open(path, range);
				}
				total += info.size;
				// Why the size as a range: the kept bytes then match the `Content-Length` from the lookup.
				bytes = files
					.open(path, { start: 0, end: info.size - 1 })
					.then(async (stream) => new Uint8Array(await new Response(stream).arrayBuffer()));
				kept.set(path, bytes);
				bytes.catch(() => {
					kept.delete(path);
					total -= info.size;
				});
			}
			// Why a copy: a later stage can change the bytes that it reads.
			const chunk = (await bytes).slice(
				range?.start ?? 0,
				range == null ? undefined : range.end + 1,
			);
			return new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(chunk);
					controller.close();
				},
			});
		},
	};
}

/** A compressed copy of a static file that the build wrote. */
type Copy = StaticFile & { encoding: Encoding };

/**
 * The copy of the file at `path` that the request prefers, from the copies
 * that the build wrote. When a copy exists, it adds `Accept-Encoding` to the
 * `Vary` in `headers`, also for a request that gets no copy.
 */
async function preferredCopy(
	context: Context<AppServerEnv>,
	{ files, path, headers }: { files: StaticFiles; path: string; headers: Headers },
): Promise<Copy | undefined> {
	// Why not for an encoded file: the copy would encode it again, under one `Content-Encoding`.
	if (
		headers.has("Content-Encoding") ||
		(context.get("rewritesHtml") === true &&
			(headers.get("Content-Type")?.startsWith("text/html") ?? false))
	) {
		return undefined;
	}
	const copies: Copy[] = [];
	for (const encoding of COPY_ENCODINGS) {
		const copy = copyPath(path, encoding);
		// oxlint-disable-next-line no-await-in-loop -- two lookups, and a snapshot answers each at once.
		const info = await files.stat(copy);
		if (info?.kind === "file") {
			copies.push({ path: copy, size: info.size, mtimeMs: info.mtimeMs, encoding });
		}
	}
	if (copies.length === 0) {
		return undefined;
	}
	const vary = withVary(headers.get("Vary"), "Accept-Encoding");
	if (vary != null) {
		headers.set("Vary", vary);
	}
	if (forbidsTransform(hookedHeaders(context, headers).get("Cache-Control"))) {
		return undefined;
	}
	const encoding = preferredEncoding(
		context.req.header("Accept-Encoding"),
		copies.map((copy) => copy.encoding),
	);
	return copies.find((copy) => copy.encoding === encoding);
}

/**
 * All bytes of a file. Why the size as a range: the body then never has more
 * bytes than its `Content-Length`, even when the file grew after `stat`, and
 * a small file reads into a small buffer.
 */
async function wholeFile(
	files: StaticFiles,
	file: StaticFile,
): Promise<ReadableStream<Uint8Array> | null> {
	return file.size === 0 ? null : files.open(file.path, { start: 0, end: file.size - 1 });
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
 * modification time, the request's `etagParts`, and its encoding. A matching
 * `If-None-Match` gets a 304, and `HEAD` gets the headers only.
 *
 * A GET with one `bytes` range gets a 206 with those bytes, and a range
 * after the end of the file gets a 416. A request with `If-Range` gets the
 * full file. Why: the ETag is weak, and `If-Range` needs a strong match. An
 * HTML file gets no ranges.
 *
 * When the build wrote a compressed copy of the file (`.<file>.br` or
 * `.<file>.gz`), the response gets `Vary: Accept-Encoding`. A request gets
 * the copy that its `Accept-Encoding` prefers, brotli before gzip, with its
 * `Content-Encoding`, an ETag for that encoding, and no range. A response
 * marked `no-transform`, also by the header hook of an earlier stage, and a
 * response that `headers` encode, never get a copy. An HTML file gets no
 * copy when an earlier stage sets `rewritesHtml`.
 *
 * @example
 * const file = await findStaticFile(files, "/llms.txt");
 * if (file != null) {
 *   return staticResponse(context, { files, file, headers: {}, contentTypes: {} });
 * }
 */
export async function staticResponse(
	context: Context<AppServerEnv>,
	{ files, file, headers, contentTypes }: StaticResponseOptions,
): Promise<Response> {
	const responseHeaders = new Headers({ "Content-Type": contentType(file.path, contentTypes) });
	for (const [name, value] of Object.entries(headers)) {
		responseHeaders.set(name, value);
	}
	// Why no ranges for HTML: a stage such as `runtimeEnv` can change the bytes of a page.
	const html = responseHeaders.get("Content-Type")?.startsWith("text/html") ?? false;
	if (html) {
		context.set("staticDocument", file.path);
	}
	// Why before the 304: a 304 sends the `Vary` and the ETag of its 200.
	const copy = await preferredCopy(context, { files, path: file.path, headers: responseHeaders });
	// Why the header first: `headers` can replace the ETag.
	const etag =
		responseHeaders.get("ETag") ??
		(await fileEtag(file, context.get("etagParts") ?? [], copy?.encoding));
	responseHeaders.set("ETag", etag);
	if (matchesEtag(context.req.header("If-None-Match"), etag)) {
		responseHeaders.delete("Content-Type");
		return new Response(null, { status: 304, headers: responseHeaders });
	}
	if (copy != null) {
		// Why no ranges: a client asks for a range of the file, not of its compressed copy.
		responseHeaders.set("Content-Encoding", copy.encoding);
		responseHeaders.set("Content-Length", String(copy.size));
		const body = context.req.method === "HEAD" ? null : await wholeFile(files, copy);
		return new Response(body, { headers: responseHeaders });
	}
	if (!html) {
		responseHeaders.set("Accept-Ranges", "bytes");
	}
	responseHeaders.set("Content-Length", String(file.size));
	if (context.req.method === "HEAD") {
		return new Response(null, { headers: responseHeaders });
	}
	const rangeHeader = context.req.header("Range");
	const range =
		html || rangeHeader == null || context.req.header("If-Range") != null
			? undefined
			: byteRange(rangeHeader, file.size);
	if (range === "unsatisfiable") {
		responseHeaders.set("Content-Range", `bytes */${file.size}`);
		responseHeaders.delete("Content-Length");
		return new Response(null, { status: 416, headers: responseHeaders });
	}
	if (range != null) {
		responseHeaders.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
		responseHeaders.set("Content-Length", String(range.end - range.start + 1));
		return new Response(await files.open(file.path, range), {
			status: 206,
			headers: responseHeaders,
		});
	}
	return new Response(await wholeFile(files, file), { headers: responseHeaders });
}
