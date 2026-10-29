import type { Context, MiddlewareHandler } from "hono";
import { manifestKey } from "../build-manifest.js";
import { isSafeLocalPath } from "../safe-local-path.js";
import { findStaticFile, staticResponse } from "../static-files.js";
import type { AppServerEnv, Plugin, StaticFiles } from "../types.js";

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Serves the hashed files under `/assets/` with a one-year immutable cache.
 * A missing asset gets a plain 404, not a rendered page. In development,
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
					return context.text("Not Found", 404);
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

/**
 * The URL with no trailing slash, when the request path ends in one slash
 * and the path with no slash finds a page (an `index.html`). Else `undefined`.
 */
async function pageRedirect(
	files: StaticFiles,
	context: Context<AppServerEnv>,
): Promise<string | undefined> {
	const { path } = context.req;
	const pagePath = path.slice(0, -1);
	if (path === "/" || !path.endsWith("/") || pagePath.endsWith("/")) {
		return undefined;
	}
	const file = await findStaticFile(files, pagePath);
	if (file == null || !file.path.endsWith("/index.html")) {
		return undefined;
	}
	// Why the raw URL: Hono decodes `path`, and a decoded `?` or non-ASCII character makes a wrong `Location`.
	const url = new URL(context.req.url);
	const location = `${url.pathname.slice(0, -1)}${url.search}`;
	// Why a second check: `findStaticFile` rejects `//` today, but the `Location` must never name another host.
	return isSafeLocalPath(location) ? location : undefined;
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
};

/**
 * Serves the client build: prerendered pages at their own URL with a 200,
 * plus every other file in it. A page URL with one trailing slash gets a 301
 * to the URL with no slash, so each page has one URL. Each response gets
 * the headers its loader sent at build time (the `appServer` Vite plugin
 * captures them), an ETag, and a 304 for a matching `If-None-Match`. A path
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
			stage = async (context, next) => {
				const { method } = context.req;
				if (method !== "GET" && method !== "HEAD") {
					return next();
				}
				const redirect = await pageRedirect(files, context);
				if (redirect != null) {
					return context.redirect(redirect, 301);
				}
				const path = options.rewrite?.(context.req.path, context) ?? context.req.path;
				const file = await findStaticFile(files, path);
				if (file == null) {
					return next();
				}
				return staticResponse(context, {
					files,
					file,
					headers: {
						...capturedHeaders.get(manifestKey(path)),
						...options.headers?.(path, context),
					},
					contentTypes,
				});
			};
		},
		middleware: async (context, next) => (stage == null ? next() : stage(context, next)),
	};
}
