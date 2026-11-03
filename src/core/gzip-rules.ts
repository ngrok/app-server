import type { Context } from "hono";
import { accepts } from "hono/accepts";

const COMPRESSIBLE =
	/^(?:text\/|application\/(?:json|javascript|xml|schema\+json|manifest\+json|x-ndjson|connect\+json)|image\/svg\+xml)/u;

/**
 * The smallest body that the server gzips. Why: gzip makes a smaller body
 * larger, and each gzip stream allocates about 300 kibibytes (KiB) of zlib
 * state. `hono/compress` uses the same value.
 */
export const MIN_GZIP_BYTES = 1024;

/** The suffix of the gzip copy of a file that the build writes next to it. */
export const GZIP_SUFFIX = ".gz";

/** Whether the server gzips a body of the content type `type`. */
export function isCompressible(type: string): boolean {
	return COMPRESSIBLE.test(type);
}

/** Whether the request accepts a gzip body. */
export function acceptsGzip(context: Context): boolean {
	return (
		accepts(context, { header: "Accept-Encoding", supports: ["gzip"], default: "identity" }) ===
		"gzip"
	);
}

/** Whether a `Cache-Control` value forbids a change to the body, such as gzip. */
export function forbidsTransform(cacheControl: string | null): boolean {
	return /\bno-transform\b/u.test(cacheControl ?? "");
}
