import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { isSafeLocalPath } from "../safe-local-path.js";
import { findStaticFile } from "../static-files.js";
import type { AppServerEnv, Plugin, StaticFiles } from "../types.js";

/**
 * How a page URL ends:
 *
 * - `never`: with no trailing slash, such as `/docs/button`.
 * - `always`: with a trailing slash, such as `/docs/button/`.
 * - `preserve`: as the request has it. The server sends no redirect.
 */
export type TrailingSlash = "never" | "always" | "preserve";

/** Options for {@link trailingSlash}. */
export type TrailingSlashOptions = {
	mode: TrailingSlash;
};

/** Whether the last segment of a URL path has a dot, as a file name such as `llms.txt` or `x.data` has. */
function isFilePath(path: string): boolean {
	return path.slice(path.lastIndexOf("/") + 1).includes(".");
}

/** `path` with no trailing slashes. Why a scan, not `/\/+$/`: that regex takes quadratic time on a long run of slashes inside the path. */
function trimTrailingSlashes(path: string): string {
	let end = path.length;
	while (end > 0 && path[end - 1] === "/") {
		end -= 1;
	}
	return path.slice(0, end);
}

/** The URL path in `mode`, or the path unchanged when `mode` keeps it. */
function canonicalPath(path: string, mode: TrailingSlash): string {
	const trimmed = trimTrailingSlashes(path);
	if (trimmed === "") {
		return "/";
	}
	if (mode === "never") {
		return trimmed;
	}
	if (mode === "always") {
		return `${trimmed}/`;
	}
	return path;
}

/**
 * Whether one of the app's own Hono routes matches the request. Why the
 * path: the plugins and the framework match at `/*`, and Hono matches a
 * route path strictly, so a redirect would move the request off its route.
 */
function hasAppRoute(context: Context<AppServerEnv>): boolean {
	return matchedRoutes(context).some((route) => route.path !== "/*");
}

/** Whether `path`, a decoded URL path, names a file in `files`, not a directory. */
async function isStaticFile(files: StaticFiles, path: string): Promise<boolean> {
	return (await findStaticFile(files, path))?.path === path;
}

/**
 * Sends a 308 from a page URL to the same URL in `mode`, so each page has one
 * URL. It applies to rendered and prerendered pages, because the server cannot
 * tell which paths have a route. The redirect keeps the query string.
 *
 * It sends no redirect for `/`, a method other than GET or HEAD, a data
 * request of the framework, a path that one of the app's own Hono routes
 * matches, such as `app.get("/livez")`, or a path that already has the
 * mode's form. `always` adds no slash to a file in the client build, such as
 * `/LICENSE`, or to a path whose last segment has a dot, such as `/llms.txt`.
 *
 * Set the same mode in the framework's router when it has one. Else the two
 * redirects loop: the server sends `/x` to `/x/`, and the router sends `/x/`
 * back to `/x`. For TanStack Start, check the mode against the router with
 * `RouterTrailingSlash` from `@ngrok/app-server/tanstack-start`. React Router
 * has no trailing-slash option, so it answers both forms itself.
 *
 * @example
 * createServer({ plugins: defaultPlugins({ trailingSlash: "always" }) });
 */
export function trailingSlash({ mode }: TrailingSlashOptions): Plugin {
	let stage: MiddlewareHandler<AppServerEnv> | undefined;
	return {
		name: "trailing-slash",
		setup: (info) => {
			if (mode === "preserve") {
				return;
			}
			stage = async (context, next) => {
				const { method } = context.req;
				if (
					(method !== "GET" && method !== "HEAD") ||
					info.isDataRequest(context.req.path) ||
					hasAppRoute(context)
				) {
					return next();
				}
				// Why the raw URL: Hono decodes `path`, but a `Location` must keep the percent-encoding.
				const url = new URL(context.req.url);
				const path = canonicalPath(url.pathname, mode);
				const location = `${path}${url.search}`;
				// Why the check: a path such as `//evil.com/` must not make a `Location` to another host.
				if (path === url.pathname || !isSafeLocalPath(location)) {
					return next();
				}
				// Why the decoded path: `/llms%2Etxt` names the file `/llms.txt`.
				if (
					mode === "always" &&
					(isFilePath(context.req.path) || (await isStaticFile(info.files, context.req.path)))
				) {
					return next();
				}
				return context.redirect(location, 308);
			};
		},
		middleware: async (context, next) => (stage == null ? next() : stage(context, next)),
	};
}
