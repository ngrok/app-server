import type { Context } from "hono";
import { getMimeType } from "hono/utils/mime";
import { COPY_ENCODINGS, copyPath, forbidsTransform, preferredEncoding } from "./compression.js";
import type { Encoding } from "./compression.js";
import { bodyHooks, hookedView } from "./header-hook.js";
import type { AppServerEnv, ByteRange, ServerEnv, StaticFiles } from "./types.js";
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

/** The most lists of `etagParts` whose hash the process keeps. */
const MAX_PARTS_HASHES = 16;

/**
 * The hash of each list of `etagParts` that a request had, oldest first. Why
 * more than one: a plugin with an `etagPart` between two static stages gives
 * the requests of each stage their own list, and so does each app of the
 * process. Why a limit: a part can change while the server runs.
 */
const partsHashes: { parts: readonly string[]; hash: string }[] = [];

/** The kept hash of `parts`, or `undefined` before the first request with them ends its digest. */
function keptPartsHash(parts: readonly string[]): string | undefined {
	for (const kept of partsHashes) {
		let same = kept.parts.length === parts.length;
		for (let index = 0; same && index < parts.length; index += 1) {
			same = kept.parts[index] === parts[index];
		}
		if (same) {
			return kept.hash;
		}
	}
	return undefined;
}

/** A short hash of the request's `etagParts`, which the process then keeps. */
async function partsHash(parts: readonly string[]): Promise<string> {
	// Why Web Crypto: each host has it, and the core imports no Node module.
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\0")));
	const hash = btoa(String.fromCodePoint(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.slice(0, 16);
	// Why the check: another request with the same parts can end its digest first.
	if (keptPartsHash(parts) == null) {
		if (partsHashes.length === MAX_PARTS_HASHES) {
			partsHashes.shift();
		}
		partsHashes.push({ parts, hash });
	}
	return hash;
}

/** Where {@link hexTime} splits a number: the low half has 24 bits, which are 6 hexadecimal digits. */
const HEX_SPLIT = 2 ** 24;

/**
 * The whole milliseconds of a time in hexadecimal, as
 * `Math.trunc(ms).toString(16)` gives them. Why two halves: V8 converts a
 * whole number under 2^31 in about 20 ns, and a larger one, as the time of a
 * file is, in about 350 ns. The halves of a safe integer are under 2^29.
 */
function hexTime(ms: number): string {
	const whole = Math.trunc(ms);
	if (whole >= HEX_SPLIT && whole <= Number.MAX_SAFE_INTEGER) {
		const high = Math.floor(whole / HEX_SPLIT);
		// Why not `%`: the remainder of a number over 2^31 takes about 10 ns more.
		const low = whole - high * HEX_SPLIT;
		return `${high.toString(16)}${low.toString(16).padStart(6, "0")}`;
	}
	return whole.toString(16);
}

/**
 * A weak ETag from a file's size, its modification time, the hash of the
 * request's `etagParts`, and the encoding of the body. Why the encoding:
 * after a 304, a cache that holds more than one encoding of the file picks
 * the stored response by its ETag (RFC 9111, section 4.3.4).
 */
function fileEtag(
	file: StaticFile,
	hash: string | undefined,
	encoding: Encoding | undefined,
): string {
	const parts = hash == null ? "" : `-${hash}`;
	const coding = encoding == null ? "" : `-${encoding}`;
	return `W/"${file.size.toString(16)}-${hexTime(file.mtimeMs)}${parts}${coding}"`;
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
		open: async (path, options) => {
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
					return files.open(path, options);
				}
				total += info.size;
				// Why the size as a range: the kept bytes then match the `Content-Length` from the lookup.
				bytes = files
					.open(path, { range: { start: 0, end: info.size - 1 } })
					.then(async (stream) => new Uint8Array(await new Response(stream).arrayBuffer()));
				kept.set(path, bytes);
				bytes.catch(() => {
					kept.delete(path);
					total -= info.size;
				});
			}
			// Why a copy: a later stage can change the bytes that it reads.
			const range = options?.range;
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
 * The headers of a static response by lowercase name, until the response is
 * made. Why not `Headers`: each call on one checks and converts its
 * arguments, and a response copies the `Headers` that it gets.
 */
type Head = Map<string, string>;

/**
 * `value` as `Headers` keeps it. Why `Headers` only for a value with white
 * space at its ends, or one that is not a string: it removes only the HTTP
 * white space, converts the value, and throws for one that is not valid.
 */
function headerValue(name: string, value: unknown): string {
	return typeof value === "string" && value.trim() === value
		? value
		: (new Headers([[name, String(value)]]).get(name) ?? "");
}

/**
 * The headers of a file: its content type, then each record of `layers`. A
 * later header replaces an earlier one, and a name matches in any case.
 */
function fileHead(type: string, layers: StaticResponseOptions["headers"]): Head {
	const head: Head = new Map([["content-type", type]]);
	for (const layer of layers) {
		for (const [name, value] of Object.entries(layer ?? {})) {
			head.set(name.toLowerCase(), headerValue(name, value));
		}
	}
	return head;
}

/**
 * The `Cache-Control` of `head` where the response leaves: after the header
 * hook of each stage that the request passed, when one of them can change
 * the body that the stage picks. The hooks change only a copy of `head`.
 */
function sentCacheControl(context: Context<ServerEnv>, head: Head): string | null {
	const hooks = bodyHooks(context);
	if (hooks == null) {
		return head.get("cache-control") ?? null;
	}
	const list: string[] = [];
	for (const [name, value] of head) {
		list.push(name, value);
	}
	return hookedView(hooks, list).get("Cache-Control");
}

/**
 * The copy of the file at `path` that the request prefers, from the copies
 * that the build wrote. When a copy exists, it adds `Accept-Encoding` to the
 * `Vary` in `head`, also for a request that gets no copy.
 */
async function preferredCopy(
	context: Context<AppServerEnv>,
	{ files, path, head }: { files: StaticFiles; path: string; head: Head },
): Promise<Copy | undefined> {
	// Why not for an encoded file: the copy would encode it again, under one `Content-Encoding`.
	if (head.has("content-encoding")) {
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
	const vary = withVary(head.get("vary") ?? null, "Accept-Encoding");
	if (vary != null) {
		head.set("vary", vary);
	}
	if (forbidsTransform(sentCacheControl(context, head))) {
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
	return file.size === 0
		? null
		: files.open(file.path, { range: { start: 0, end: file.size - 1 } });
}

/**
 * A response with the headers of `head`. Why not a `headers` option: the
 * response converts and copies it, which costs about 30% more for six
 * headers than a `set` for each.
 */
function respond(body: ReadableStream<Uint8Array> | null, status: number, head: Head): Response {
	const response = new Response(body, { status });
	for (const [name, value] of head) {
		response.headers.set(name, value);
	}
	return response;
}

/** The requests of {@link rewritesHtmlWithEtagPart}. */
const changedWithEtagPart = new WeakSet<Context<AppServerEnv>>();

/**
 * Tells the static stages that a stage of the request changes the bytes of
 * each HTML page, as `rewritesHtml` does, and that the `etagPart` of its
 * plugin has each value that the change depends on. So the page keeps an
 * ETag, which has that value, and a matching `If-None-Match` gets a 304.
 * Call it before `next()`, in place of `rewritesHtml`.
 *
 * @example
 * rewritesHtmlWithEtagPart(context);
 * await next();
 */
export function rewritesHtmlWithEtagPart(context: Context<AppServerEnv>): void {
	changedWithEtagPart.add(context);
}

/** Whether a stage of the request changes the bytes of each HTML page. */
function changesPages(context: Context<AppServerEnv>): boolean {
	return context.get("rewritesHtml") === true || changedWithEtagPart.has(context);
}

/**
 * The response for an HTML file that a stage of the request changes: the
 * file as it is on disk, with no compressed copy and no `Content-Length`,
 * because the stage changes the bytes and their length.
 *
 * With `rewritesHtml`, the page gets no ETag and no 304. Why: the server
 * does not know which values the change depends on, so a 304 could keep a
 * page that the stage made with an old value. Without it, the request's
 * `etagParts` have these values (see {@link rewritesHtmlWithEtagPart}).
 */
async function changedPage(
	context: Context<ServerEnv>,
	{ files, file, head }: { files: StaticFiles; file: StaticFile; head: Head },
): Promise<Response> {
	// Why not the ETag or the length of `headers`: they are for the bytes of the file.
	head.delete("etag");
	head.delete("content-length");
	if (context.get("rewritesHtml") !== true) {
		const parts = context.get("etagParts") ?? [];
		const hash =
			parts.length === 0 ? undefined : (keptPartsHash(parts) ?? (await partsHash(parts)));
		const etag = fileEtag(file, hash, undefined);
		head.set("etag", etag);
		if (matchesEtag(context.req.header("If-None-Match"), etag)) {
			head.delete("content-type");
			return respond(null, 304, head);
		}
	}
	return respond(context.req.method === "HEAD" ? null : await wholeFile(files, file), 200, head);
}

/** What {@link staticResponse} needs besides the request. */
export type StaticResponseOptions = {
	files: StaticFiles;
	file: StaticFile;
	/**
	 * Headers that replace the defaults, so a captured `Content-Type` wins
	 * over the one from the file name. A later record replaces an earlier one,
	 * and a name matches in any case.
	 */
	headers: readonly (Readonly<Record<string, string>> | undefined)[];
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
 * response that `headers` encode, never get a copy.
 *
 * When an earlier stage changes the bytes of each HTML page, an HTML file
 * goes out as it is on disk, with no copy and no `Content-Length`. With
 * `rewritesHtml`, it also has no ETag, and an `If-None-Match` gets the full
 * page. With {@link rewritesHtmlWithEtagPart}, it keeps an ETag and its 304.
 *
 * @example
 * const file = await findStaticFile(files, "/llms.txt");
 * if (file != null) {
 *   return staticResponse(context, { files, file, headers: [], contentTypes: {} });
 * }
 */
export async function staticResponse(
	context: Context<ServerEnv>,
	{ files, file, headers, contentTypes }: StaticResponseOptions,
): Promise<Response> {
	const head = fileHead(contentType(file.path, contentTypes), headers);
	// Why no ranges for HTML: a stage such as `runtimeEnv` can change the bytes of a page.
	const html = head.get("content-type")?.startsWith("text/html") ?? false;
	if (html) {
		context.set("staticDocument", file.path);
		if (changesPages(context)) {
			return changedPage(context, { files, file, head });
		}
	}
	// Why before the 304: a 304 sends the `Vary` and the ETag of its 200.
	const copy = await preferredCopy(context, { files, path: file.path, head });
	// Why the header first: `headers` can replace the ETag.
	let etag = head.get("etag");
	if (etag == null) {
		const parts = context.get("etagParts") ?? [];
		// Why `await` only for a new list of parts: each later request has the hash at once.
		const hash =
			parts.length === 0 ? undefined : (keptPartsHash(parts) ?? (await partsHash(parts)));
		etag = fileEtag(file, hash, copy?.encoding);
		head.set("etag", etag);
	}
	if (matchesEtag(context.req.header("If-None-Match"), etag)) {
		head.delete("content-type");
		return respond(null, 304, head);
	}
	if (copy != null) {
		// Why no ranges: a client asks for a range of the file, not of its compressed copy.
		head.set("content-encoding", copy.encoding);
		head.set("content-length", String(copy.size));
		return respond(context.req.method === "HEAD" ? null : await wholeFile(files, copy), 200, head);
	}
	if (!html) {
		head.set("accept-ranges", "bytes");
	}
	head.set("content-length", String(file.size));
	if (context.req.method === "HEAD") {
		return respond(null, 200, head);
	}
	const rangeHeader = context.req.header("Range");
	const range =
		html || rangeHeader == null || context.req.header("If-Range") != null
			? undefined
			: byteRange(rangeHeader, file.size);
	if (range === "unsatisfiable") {
		head.set("content-range", `bytes */${file.size}`);
		head.delete("content-length");
		return respond(null, 416, head);
	}
	if (range != null) {
		head.set("content-range", `bytes ${range.start}-${range.end}/${file.size}`);
		head.set("content-length", String(range.end - range.start + 1));
		return respond(await files.open(file.path, { range }), 206, head);
	}
	return respond(await wholeFile(files, file), 200, head);
}
