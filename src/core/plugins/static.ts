import type { Context, MiddlewareHandler } from "hono";
import { manifestKey } from "../build-manifest.js";
import { prefersMarkdown } from "../prefers-markdown.js";
import { findStaticFile, staticResponse } from "../static-files.js";
import type { StaticFile } from "../static-files.js";
import type { AppServerEnv, Plugin, StaticFiles } from "../types.js";
import { trimTrailingSlashes } from "./trailing-slash.js";

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Serves the hashed files under `/assets/` with a one-year immutable cache.
 * A missing asset gets a plain 404 with `Cache-Control: no-store`, not a
 * rendered page. In development,
 * the dev server serves the source modules, the HMR client, and the CSS here
 * instead.
 *
 * @example
 * createServer({ plugins: [requestId(), accessLog(), streamingCompress(), assets(), prerendered()] });
 */
export function assets(): Plugin {
	let stage: MiddlewareHandler<AppServerEnv> | undefined;
	return {
		name: "assets",
		setup: (info) => {
			if (info.mode === "development") {
				stage = info.devServer;
				return;
			}
			const { files, contentTypes } = info;
			stage = async (context, next) => {
				const { method, path } = context.req;
				if (!path.startsWith("/assets/") || (method !== "GET" && method !== "HEAD")) {
					return next();
				}
				const file = await findStaticFile(files, path);
				if (file == null) {
					// Why `no-store`: an old tab asks for the chunks of the build it runs, and a CDN must not keep the miss.
					return context.text("Not Found", 404, { "Cache-Control": "no-store" });
				}
				return staticResponse(context, {
					files,
					file,
					headers: { "Cache-Control": IMMUTABLE },
					contentTypes,
				});
			};
		},
		middleware: async (context, next) => (stage == null ? next() : stage(context, next)),
	};
}

/** Options for {@link prerendered}. */
export type PrerenderedOptions = {
	/**
	 * Extra headers for a served file, by its URL path. They replace the
	 * headers captured at build time.
	 */
	headers?: (
		path: string,
		context: Context<AppServerEnv>,
	) => Readonly<Record<string, string>> | undefined;
	/**
	 * Maps a request path to the URL path of the file to serve, for content
	 * negotiation. Return the path unchanged to serve the usual file. The
	 * returned path follows the rules of a request path: one URL for each
	 * file, no dotfiles, and nothing outside the client build. When the
	 * answer depends on a request header, add a `Vary` for it in a plugin.
	 */
	rewrite?: (path: string, context: Context<AppServerEnv>) => string;
	/**
	 * Serves the markdown twin of a page, such as `/docs/button.md` for
	 * `/docs/button`, to a request that {@link prefersMarkdown} accepts. A
	 * page has a twin when `twinOf` names a file in the client build.
	 *
	 * - A request that prefers markdown gets the twin, with the twin's
	 *   captured headers. `rewrite` does not run for it.
	 * - Each answer for a path with a twin gets `Vary: Accept`: the twin, the
	 *   prerendered HTML, and the framework's answer. The server adds
	 *   `Accept` to the `Vary` header and keeps the values in it.
	 * - A path with no twin gets no `Vary: Accept`, so a request for the
	 *   twin's own URL gets none.
	 *
	 * `true` uses the default `twinOf`: the path with no trailing slash plus
	 * `.md`, and `/index.md` for `/`. The returned path follows the rules of a
	 * request path.
	 *
	 * @example
	 * prerendered({ markdownTwins: { twinOf: (path) => `/markdown${path}.md` } });
	 */
	markdownTwins?: boolean | { twinOf: (path: string) => string | undefined };
	/**
	 * Sends a request path to the next stage, with no file lookup. Use it for
	 * private pages, so the auth check in the app or the framework runs for
	 * them. A data request has its own path, such as `/app.data` in React
	 * Router.
	 *
	 * @example
	 * prerendered({ skip: (path) => path === "/app" || path.startsWith("/app/") || path.startsWith("/app.") });
	 */
	skip?: (path: string) => boolean;
	/**
	 * The `Cache-Control` of a served file, by the file's URL path, such as
	 * `/about/index.html`. `undefined` sends none. A header that the build
	 * captured, and the `headers` option, win over it.
	 *
	 * The default gives an HTML page and a data file of the framework
	 * `public, max-age=0, must-revalidate`, so a visitor always sees the newest
	 * page, and a 304 keeps it fast. It gives every other file
	 * `public, max-age=3600, stale-while-revalidate=86400`.
	 *
	 * @example
	 * prerendered({ cacheControl: (path) => (path.startsWith("/images/") ? "public, max-age=86400" : undefined) });
	 */
	cacheControl?: (path: string) => string | undefined;
};

const REVALIDATE = "public, max-age=0, must-revalidate";
const ONE_HOUR = "public, max-age=3600, stale-while-revalidate=86400";

/** The default markdown twin of a page: `/docs/button.md` for `/docs/button`, and `/index.md` for `/`. */
function defaultTwinOf(path: string): string {
	return `${trimTrailingSlashes(path) || "/index"}.md`;
}

/** The file of the markdown twin of `path`, or `undefined` when the page has none. */
async function findTwin(
	files: StaticFiles,
	path: string,
	twinOf: ((path: string) => string | undefined) | undefined,
): Promise<{ path: string; file: StaticFile } | undefined> {
	const twinPath = twinOf?.(path);
	const file = twinPath == null ? undefined : await findStaticFile(files, twinPath);
	return twinPath == null || file == null ? undefined : { path: twinPath, file };
}

/** A `Vary` value with `Accept` added, or `undefined` when `vary` already covers `Accept`. */
function varyWithAccept(vary: string | null): string | undefined {
	if (vary == null || vary.trim() === "") {
		return "Accept";
	}
	const values = new Set(vary.split(",").map((value) => value.trim().toLowerCase()));
	return values.has("accept") || values.has("*") ? undefined : `${vary}, Accept`;
}

/** The `twinOf` function that the `markdownTwins` option selects, or `undefined` when it is off. */
function twinOfOption(
	markdownTwins: PrerenderedOptions["markdownTwins"],
): ((path: string) => string | undefined) | undefined {
	if (markdownTwins === true) {
		return defaultTwinOf;
	}
	if (markdownTwins == null || markdownTwins === false) {
		return undefined;
	}
	return markdownTwins.twinOf;
}

/**
 * Serves the client build: prerendered pages at their own URL with a 200,
 * plus every other file in it. It sends no redirect. The `trailingSlash`
 * plugin does. Each response gets
 * the headers its loader sent at build time (the `appServer` Vite plugin
 * captures them), a `Cache-Control` (see `cacheControl`), an ETag, and a 304
 * for a matching `If-None-Match`. A GET with one byte range gets a 206. A path
 * with no file goes on to the framework. Off in development.
 *
 * At startup, it warns about each prerendered path that has no file.
 *
 * @example
 * prerendered({
 * 	headers: (path) => (path.startsWith("/api/") ? { "Access-Control-Allow-Origin": "*" } : undefined),
 * });
 */
export function prerendered(options: PrerenderedOptions = {}): Plugin {
	let stage: MiddlewareHandler<AppServerEnv> | undefined;
	return {
		name: "prerendered",
		setup: async (info) => {
			if (info.mode === "development") {
				return;
			}
			const { files, contentTypes, capturedHeaders } = info;
			const missing: string[] = [];
			for (const path of info.prerenderedPaths) {
				if ((await findStaticFile(files, path)) == null) {
					missing.push(path);
				}
			}
			if (missing.length > 0) {
				// Why a warning: a path with no file falls through to the framework, which still answers.
				info.logger.log("warn", "prerendered paths with no file", {
					"app_server.missing_paths": missing,
				});
			}
			const twinOf = twinOfOption(options.markdownTwins);
			const cacheControl =
				options.cacheControl ??
				((path: string) =>
					path.endsWith(".html") || info.isDataRequest(path) ? REVALIDATE : ONE_HOUR);
			const serve = async (context: Context<AppServerEnv>, path: string, file: StaticFile) => {
				const value = cacheControl(file.path);
				return staticResponse(context, {
					files,
					file,
					headers: {
						...(value == null ? {} : { "Cache-Control": value }),
						...capturedHeaders.get(manifestKey(path)),
						...options.headers?.(path, context),
					},
					contentTypes,
				});
			};
			stage = async (context, next) => {
				const { method } = context.req;
				if ((method !== "GET" && method !== "HEAD") || options.skip?.(context.req.path) === true) {
					return next();
				}
				const twin = await findTwin(files, context.req.path, twinOf);
				const preferred = twin != null && prefersMarkdown(context.req.raw) ? twin : undefined;
				const path =
					preferred?.path ?? options.rewrite?.(context.req.path, context) ?? context.req.path;
				const file = preferred?.file ?? (await findStaticFile(files, path));
				if (file == null) {
					await next();
				} else {
					context.res = await serve(context, path, file);
				}
				const vary = twin == null ? undefined : varyWithAccept(context.res.headers.get("Vary"));
				if (vary != null) {
					// Why `context.header`: it also works on a framework response with immutable headers.
					context.header("Vary", vary);
				}
			};
		},
		middleware: async (context, next) => (stage == null ? next() : stage(context, next)),
	};
}
