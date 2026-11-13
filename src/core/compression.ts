import { parseAccept } from "hono/utils/accept";

/**
 * The content types that the server and the build compress: each text type,
 * each type with a `+json` or `+xml` suffix, and the other types that
 * `mime-db` marks compressible and that a site sends, such as `image/x-icon`
 * and `font/ttf`. Why not `font/woff` and `font/woff2`: they are compressed
 * already.
 */
const COMPRESSIBLE =
	/^(?:text\/|[\w-]+\/[\w.-]+\+(?:json|xml)|application\/(?:json|xml|javascript|x-ndjson|wasm|yaml|x-yaml|x-sh\b|vnd\.ms-fontobject)|image\/(?:x-icon|vnd\.microsoft\.icon|bmp)|font\/(?:ttf|otf))/u;

/**
 * The smallest body that the server or the build compresses. Why: gzip
 * makes a smaller body larger, and each gzip stream allocates about 300
 * kibibytes (KiB) of zlib state. `hono/compress` uses the same value.
 */
export const MIN_COMPRESS_BYTES = 1024;

/** A content coding of a compressed copy that the build writes. */
export type Encoding = "br" | "gzip";

/**
 * The encodings of the copies, in the order that the server prefers them.
 * Why brotli first: its copy is smaller, such as 45 KB in place of 56 KB
 * for a docs page of 417 KB.
 */
export const COPY_ENCODINGS: readonly Encoding[] = ["br", "gzip"];

const COPY_EXTENSIONS: Readonly<Record<Encoding, string>> = { br: "br", gzip: "gz" };

/**
 * The name of the `encoding` copy of the file `name`, which the build writes
 * next to it.
 *
 * Why a dotfile: the static stages never serve a dotfile, so the copy has no
 * URL of its own. A request gets the copy only through the URL of its file,
 * which `skip` and an auth check can block. The build also never replaces or
 * removes a `.gz` or `.br` file of the app.
 *
 * @example
 * copyName("app-abc.js", "br"); // => ".app-abc.js.br"
 */
export function copyName(name: string, encoding: Encoding): string {
	return `.${name}.${COPY_EXTENSIONS[encoding]}`;
}

/**
 * The URL path of the `encoding` copy of the file at the URL path `path`.
 *
 * @example
 * copyPath("/assets/app-abc.js", "br"); // => "/assets/.app-abc.js.br"
 */
export function copyPath(path: string, encoding: Encoding): string {
	const name = path.lastIndexOf("/") + 1;
	return `${path.slice(0, name)}${copyName(path.slice(name), encoding)}`;
}

/**
 * Whether the server compresses a body of the content type `type`.
 *
 * @example
 * isCompressible("text/html; charset=utf-8"); // => true
 * isCompressible("image/png"); // => false
 */
export function isCompressible(type: string): boolean {
	return COMPRESSIBLE.test(type);
}

/**
 * The encoding in `offered` that an `Accept-Encoding` header prefers, or
 * `undefined` for the body as it is. Each encoding gets the `q` of its own
 * entry, else of `*`. The highest `q` above 0 wins, and a tie goes to the
 * first encoding in `offered`. An `identity` entry with a higher `q` keeps
 * the body as it is.
 *
 * @example
 * preferredEncoding("gzip, deflate, br", ["br", "gzip"]); // => "br"
 * preferredEncoding("br;q=0, gzip", ["br", "gzip"]); // => "gzip"
 */
export function preferredEncoding(
	header: string | undefined,
	offered: readonly Encoding[],
): Encoding | undefined {
	const entries = parseAccept(header ?? "");
	const quality = (coding: string) =>
		(
			entries.find((entry) => entry.type.toLowerCase() === coding) ??
			entries.find((entry) => entry.type === "*")
		)?.q ?? 0;
	let best: Encoding | undefined;
	let bestQuality = 0;
	for (const encoding of offered) {
		const value = quality(encoding);
		if (value > bestQuality) {
			best = encoding;
			bestQuality = value;
		}
	}
	// Why only an `identity` entry: with no entry, identity is acceptable, but the client prefers a coding that it names.
	const identity = entries.find((entry) => entry.type.toLowerCase() === "identity")?.q;
	return identity != null && identity > bestQuality ? undefined : best;
}

/**
 * Whether a `Cache-Control` value forbids a change to the body, such as gzip.
 *
 * @example
 * forbidsTransform("public, no-transform"); // => true
 * forbidsTransform("public, max-age=3600"); // => false
 */
export function forbidsTransform(cacheControl: string | null): boolean {
	return /\bno-transform\b/u.test(cacheControl ?? "");
}

/** The result of one read of a byte stream. */
export type ReadResult = ReadableStreamReadResult<Uint8Array>;

/**
 * The next result if `reader` has it queued, or the read that is still open.
 * It never waits for the source.
 *
 * @example
 * const next = await readIfQueued(reader); // => { result: { done: false, value } } or { pending }
 */
export async function readIfQueued(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ result: ReadResult } | { pending: Promise<ReadResult> }> {
	const pending = reader.read();
	// Why: a client that leaves before the body is read must not cause an unhandled rejection.
	pending.catch(() => {});
	const result = await Promise.race([pending, Promise.resolve().then(async () => undefined)]);
	return result == null ? { pending } : { result };
}
