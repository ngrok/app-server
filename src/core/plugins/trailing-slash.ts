import type { MiddlewareHandler } from "hono";
import { isSafeLocalPath } from "../safe-local-path.js";
import type { AppServerEnv, Plugin } from "../types.js";

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

/** The URL path in `mode`, or the path unchanged when `mode` keeps it. */
function canonicalPath(path: string, mode: TrailingSlash): string {
	const trimmed = path.replace(/\/+$/u, "");
	if (trimmed === "") {
		return "/";
	}
	if (mode === "never") {
		return trimmed;
	}
	if (mode === "always" && !isFilePath(trimmed)) {
		return `${trimmed}/`;
	}
	return path;
}

/**
 * Sends a 308 from a page URL to the same URL in `mode`, so each page has one
 * URL. It applies to rendered and prerendered pages, because the server cannot
 * tell which paths have a route. The redirect keeps the query string.
 *
 * It sends no redirect for `/`, a POST or other method that is not GET or
 * HEAD, a data request of the framework, or a path that already has the
 * mode's form. `always` adds no slash to a path whose last segment has a
 * dot, such as `/llms.txt`.
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
				if ((method !== "GET" && method !== "HEAD") || info.isDataRequest(context.req.path)) {
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
				return context.redirect(location, 308);
			};
		},
		middleware: async (context, next) => (stage == null ? next() : stage(context, next)),
	};
}
