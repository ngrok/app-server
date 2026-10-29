import type { Context, MiddlewareHandler } from "hono";
import { manifestKey } from "../build-manifest.js";
import { findStaticFile, staticResponse } from "../static-files.js";
import type { AppServerEnv, Plugin } from "../types.js";

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
 * plus every other file in it. It sends no redirect. The `trailingSlash`
 * plugin does. Each response gets
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
