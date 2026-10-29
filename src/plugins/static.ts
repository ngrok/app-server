import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { Context, MiddlewareHandler } from "hono";
import { capturedHeadersKey, readCapturedHeaders } from "../captured-headers.js";
import { findStaticFile, staticResponse } from "../static-files.js";
import type { AppServerEnv, NodeMiddleware, Plugin } from "../types.js";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Runs Vite's middleware inside the pipeline. Vite answers or calls `next`. */
function viteStage(viteMiddleware: NodeMiddleware): MiddlewareHandler<AppServerEnv> {
	return async (context, next) => {
		const { incoming, outgoing } = context.env;
		if (incoming == null || outgoing == null) {
			return next();
		}
		// Why before Vite: it sends the headers itself, so the headers the earlier stages set, such
		// as the request ID, must be on `outgoing` first.
		for (const [name, value] of context.res.headers) {
			outgoing.appendHeader(name, value);
		}
		const answered = await new Promise<boolean>((resolve, reject) => {
			const onFinish = () => {
				resolve(true);
			};
			outgoing.once("finish", onFinish);
			viteMiddleware(incoming, outgoing, (error) => {
				outgoing.off("finish", onFinish);
				if (error == null) {
					resolve(false);
				} else {
					reject(new Error("Vite middleware failed", { cause: error }));
				}
			});
		});
		if (answered) {
			// Why a new response per request: the later stages set headers on it. The headers of
			// `RESPONSE_ALREADY_SENT` tell `@hono/node-server` to send nothing. The status and length
			// are Vite's, for the access log.
			const headers = new Headers(RESPONSE_ALREADY_SENT.headers);
			const length = outgoing.getHeader("Content-Length");
			if (length != null) {
				headers.set("Content-Length", String(length));
			}
			return new Response(null, { status: outgoing.statusCode, headers });
		}
		return next();
	};
}

/**
 * Serves the hashed files under `/assets/` with a one-year immutable cache.
 * A missing asset gets a plain 404, not a rendered page. In development,
 * Vite serves the source modules, the HMR client, and the CSS here instead.
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
				stage = viteStage(info.viteMiddleware);
				return;
			}
			const root = info.clientDirectory;
			stage = async (context, next) => {
				const { method, path } = context.req;
				if (!path.startsWith("/assets/") || (method !== "GET" && method !== "HEAD")) {
					return next();
				}
				const file = await findStaticFile(root, path);
				if (file == null) {
					return context.text("Not Found", 404);
				}
				return staticResponse(context, file, { "Cache-Control": IMMUTABLE });
			};
		},
		middleware: (context, next) => (stage == null ? next() : stage(context, next)),
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
 * Serves the client build: prerendered pages at their own URL with a 200 and
 * no trailing-slash redirect, plus every other file in it. Each response gets
 * the headers its loader sent at build time (the `serverEntry` Vite plugin
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
			const root = info.clientDirectory;
			const captured = await readCapturedHeaders(root);
			const missing: string[] = [];
			for (const path of info.prerenderedPaths) {
				if ((await findStaticFile(root, path)) == null) {
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
				const file = await findStaticFile(root, path);
				if (file == null) {
					return next();
				}
				return staticResponse(context, file, {
					...captured.get(capturedHeadersKey(path)),
					...options.headers?.(path, context),
				});
			};
		},
		middleware: (context, next) => (stage == null ? next() : stage(context, next)),
	};
}
