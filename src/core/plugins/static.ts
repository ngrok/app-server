import type { Context, MiddlewareHandler } from "hono";
import { getPath } from "hono/utils/url";
import { manifestKey } from "../build-manifest.js";
import { writableHeaders } from "../header-hook.js";
import { prefersMarkdown } from "../prefers-markdown.js";
import { contentType, findStaticFile, isFilePath, staticResponse } from "../static-files.js";
import { withVary } from "../vary.js";
import type { StaticFile } from "../static-files.js";
import type { AppServerEnv, Plugin, StaticFiles } from "../types.js";
import { trimTrailingSlashes } from "./trailing-slash.js";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** The requests that the dev server answered. */
const devServerAnswers = new WeakSet<Context<AppServerEnv>>();

/**
 * Whether the dev server answered the request, such as for a source module.
 * Why: the access log writes no line for such a request, because one page
 * load in development makes hundreds of them.
 *
 * @example
 * await next();
 * if (answeredByDevServer(context)) return;
 */
export function answeredByDevServer(context: Context<AppServerEnv>): boolean {
	return devServerAnswers.has(context);
}

/**
 * Serves the hashed files under Vite's `build.assetsDir`, `/assets/` by
 * default, with a one-year immutable cache. The `appServer` Vite plugin
 * records the directory. A missing asset gets a plain 404 with
 * `Cache-Control: no-store`, not a rendered page. In development, the dev
 * server serves the source modules, the HMR client, and the CSS here instead.
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
				const { devServer } = info;
				stage = async (context, next) => {
					let passed = false;
					const answer = await devServer(context, async () => {
						passed = true;
						await next();
					});
					if (!passed) {
						devServerAnswers.add(context);
					}
					return answer;
				};
				return;
			}
			const { files, contentTypes, assetsPath } = info;
			stage = async (context, next) => {
				const { method, path } = context.req;
				if (!path.startsWith(assetsPath) || (method !== "GET" && method !== "HEAD")) {
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
	headers?: (file: {
		path: string;
		context: Context<AppServerEnv>;
	}) => Readonly<Record<string, string>> | undefined;
	/**
	 * Maps a request path to the URL path of the file to serve, for content
	 * negotiation. Return the path unchanged to serve the usual file. The
	 * returned path follows the rules of a request path: one URL for each
	 * file, no dotfiles, and nothing outside the client build. When the
	 * answer depends on a request header, add a `Vary` for it in a plugin.
	 * With `markdownTwins: true`, a request that `rewrite` changes gets no twin.
	 */
	rewrite?: (request: { path: string; context: Context<AppServerEnv> }) => string;
	/**
	 * Serves the markdown twin of a page, such as `/docs/button.md` for
	 * `/docs/button`, to a request that {@link prefersMarkdown} accepts. A
	 * page has a twin when `twinOf` names a file in the client build. `twinOf`
	 * gets the request path and the request's Hono context, the same as
	 * `rewrite`. It returns `undefined` for a request with no twin.
	 *
	 * - A request that prefers markdown gets the twin, with the twin's
	 *   captured headers.
	 * - Each answer for a path with a twin gets `Vary: Accept`: the twin, the
	 *   prerendered HTML, and the framework's answer. The server adds
	 *   `Accept` to the `Vary` header and keeps the values in it.
	 * - Each answer for a path with a twin, except the twin, gets
	 *   `Link: <twin>; rel="alternate"; type="text/markdown"`, so a client can
	 *   find the twin.
	 * - A path with no twin gets no `Vary: Accept` and no `Link`, so a request
	 *   for the twin's own URL gets none.
	 * - In development, the client build has no twins. A request that prefers
	 *   markdown gets the framework's answer for the twin's URL, so an edit
	 *   shows at once. When the framework knows the paths that the build will
	 *   prerender, as React Router does, only those twins count. An error, or
	 *   an answer that is not markdown, gives the HTML.
	 * - A plugin after `prerendered` does not see a twin, as it does not see
	 *   a prerendered file.
	 *
	 * `true` uses the default `twinOf`: the path with no trailing slash plus
	 * `.md`, and `/index.md` for `/`. A request that `rewrite` changes gets no
	 * twin, so it gets the same page as a browser. The returned path follows
	 * the rules of a request path.
	 *
	 * @example
	 * prerendered({ markdownTwins: { twinOf: ({ path }) => `/markdown${path}.md` } });
	 */
	markdownTwins?: boolean | { twinOf: TwinOf };
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
	 * The default gives an HTML page, a markdown file, and a data file of the
	 * framework `public, max-age=0, must-revalidate`, so a visitor always sees
	 * the newest page and its markdown twin, and a 304 keeps it fast. It gives every other file
	 * `public, max-age=3600, stale-while-revalidate=86400`.
	 *
	 * @example
	 * prerendered({ cacheControl: (path) => (path.startsWith("/images/") ? "public, max-age=86400" : undefined) });
	 */
	cacheControl?: (path: string) => string | undefined;
};

/** Maps a request to the URL path of its markdown twin, or `undefined` when it has none. */
type TwinOf = (request: { path: string; context: Context<AppServerEnv> }) => string | undefined;

/**
 * The twin of a request, from its path and the path that `rewrite` gives for
 * it, or `undefined` when it has none.
 */
type FindTwinPath = (
	path: string,
	rewritten: string,
	context: Context<AppServerEnv>,
) => string | undefined;

const REVALIDATE = "public, max-age=0, must-revalidate";
const ONE_HOUR = "public, max-age=3600, stale-while-revalidate=86400";

/**
 * The default markdown twin of a page: `/docs/button.md` for `/docs/button`,
 * and `/index.md` for `/`. Why none for a rewritten request: `rewrite` sends
 * it to another file or to the framework, so the page's twin does not match
 * its answer.
 */
function defaultTwinOf(path: string, rewritten: string): string | undefined {
	return rewritten === path ? `${trimTrailingSlashes(path) || "/index"}.md` : undefined;
}

/** The file of the markdown twin of the request, or `undefined` when the page has none. */
async function findTwin(
	files: StaticFiles,
	context: Context<AppServerEnv>,
	{ twinOf, rewritten }: { twinOf: FindTwinPath | undefined; rewritten: string },
): Promise<{ path: string; file: StaticFile } | undefined> {
	const twinPath = twinOf?.(context.req.path, rewritten, context);
	const file = twinPath == null ? undefined : await findStaticFile(files, twinPath);
	return twinPath == null || file == null ? undefined : { path: twinPath, file };
}

/** Adds `Vary: Accept` to the answer for a path with a twin, so a shared cache keeps both answers. */
function varyOnAccept(context: Context<AppServerEnv>): void {
	const vary = withVary(context.res.headers.get("Vary"), "Accept");
	if (vary != null) {
		writableHeaders(context).set("Vary", vary);
	}
}

/**
 * The percent-encoded URL path for a decoded path, so it holds no space,
 * `>`, or non-ASCII character. Why the replace: a URL removes a tab or a
 * newline, which a file name can hold.
 */
function urlPath(path: string): string {
	return new URL(
		path.replaceAll(/[\t\n\r]/gu, (character) => encodeURIComponent(character)),
		"http://localhost",
	).pathname;
}

/** Adds a `Link` to the twin at `twinPath`, so a client that does not ask for markdown can find it. */
function linkToTwin(context: Context<AppServerEnv>, twinPath: string): void {
	writableHeaders(context).append(
		"Link",
		`<${urlPath(twinPath)}>; rel="alternate"; type="text/markdown"`,
	);
}

/**
 * The development stage of `markdownTwins`. The client build has no twins
 * then, so a request that prefers markdown gets the framework's answer for
 * the twin's URL: the route that prerenders the twin. A twin path that is not
 * in `prerenderedPaths`, an error, or an answer that is not markdown sends the
 * request on for the HTML.
 */
function developmentTwins(
	twinOf: FindTwinPath,
	{ rewrite, skip }: Pick<PrerenderedOptions, "rewrite" | "skip">,
	prerenderedPaths: ReadonlySet<string> | undefined,
): MiddlewareHandler<AppServerEnv> {
	return async (context, next) => {
		const { method, path } = context.req;
		const twinPath =
			(method === "GET" || method === "HEAD") &&
			skip?.(path) !== true &&
			prefersMarkdown(context.req.raw)
				? twinOf(path, rewrite?.({ path, context }) ?? path, context)
				: undefined;
		// Why both checks: production has no twin that the build does not prerender, or at a path that fails `isFilePath`.
		if (
			twinPath == null ||
			(prerenderedPaths != null && !prerenderedPaths.has(twinPath)) ||
			!isFilePath(twinPath)
		) {
			return next();
		}
		const url = new URL(context.req.url);
		url.pathname = urlPath(twinPath);
		// Why: the URL can change the path, for example `%2e%2e` to `..`. Then the framework answers a path that `twinOf` did not name.
		if (getPath(new Request(url)) !== twinPath) {
			return next();
		}
		const { headers, signal } = context.req.raw;
		// Why no `Request` as the init: the Node.js listener's request is not one that `Request` can copy.
		const twin = new Request(url, { method, headers, signal });
		const response = await context.env.framework.fetch(twin, context);
		// Why only markdown: production serves a twin from a `.md` file, so an HTML page or an error is no twin.
		// A 304 has no body to check, and it answers a validator from the twin.
		const markdown =
			response.headers.get("Content-Type")?.toLowerCase().startsWith("text/markdown") === true;
		if (response.status !== 304 && !(response.ok && markdown)) {
			await response.body?.cancel();
			return next();
		}
		context.res = response;
		varyOnAccept(context);
	};
}

/** The twin lookup that the `markdownTwins` option selects, or `undefined` when it is off. */
function twinOfOption(
	markdownTwins: PrerenderedOptions["markdownTwins"],
): FindTwinPath | undefined {
	if (markdownTwins === true) {
		return defaultTwinOf;
	}
	if (markdownTwins == null || markdownTwins === false) {
		return undefined;
	}
	const { twinOf } = markdownTwins;
	return (path, _rewritten, context) => twinOf({ path, context });
}

/**
 * Serves the client build: prerendered pages at their own URL with a 200,
 * plus every other file in it. It sends no redirect. The `trailingSlash`
 * plugin does. Each response gets
 * the headers its loader sent at build time (the `appServer` Vite plugin
 * captures them), a `Cache-Control` (see `cacheControl`), an ETag, and a 304
 * for a matching `If-None-Match`. A GET with one byte range gets a 206. A path
 * with no file goes on to the framework. In development, only
 * `markdownTwins` runs.
 *
 * At startup, it warns about each prerendered path that has no file.
 *
 * @example
 * prerendered({
 * 	headers: ({ path }) => (path.startsWith("/api/") ? { "Access-Control-Allow-Origin": "*" } : undefined),
 * });
 */
export function prerendered(options: PrerenderedOptions = {}): Plugin {
	let stage: MiddlewareHandler<AppServerEnv> | undefined;
	return {
		name: "prerendered",
		setup: async (info) => {
			const twinOf = twinOfOption(options.markdownTwins);
			if (info.mode === "development") {
				const paths = info.prerenderedPaths;
				stage =
					twinOf == null
						? undefined
						: developmentTwins(twinOf, options, paths == null ? undefined : new Set(paths));
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
				info.logger.log({
					level: "warn",
					message: "prerendered paths with no file",
					attributes: {
						"app_server.missing_paths": missing,
					},
				});
			}
			const cacheControl =
				options.cacheControl ??
				((path: string) => {
					const type = contentType(path, contentTypes);
					return type.startsWith("text/html") ||
						type.startsWith("text/markdown") ||
						info.isDataRequest(path)
						? REVALIDATE
						: ONE_HOUR;
				});
			const serve = async (context: Context<AppServerEnv>, path: string, file: StaticFile) => {
				context.env.onServedFile?.(file.path);
				const value = cacheControl(file.path);
				const headers = new Headers(value == null ? undefined : { "Cache-Control": value });
				// Why `Headers`: the build captures lowercase names, and each layer must replace the one before it in any case.
				for (const layer of [
					capturedHeaders.get(manifestKey(path)),
					options.headers?.({ path, context }),
				]) {
					for (const [name, layerValue] of Object.entries(layer ?? {})) {
						headers.set(name, layerValue);
					}
				}
				return staticResponse(context, {
					files,
					file,
					headers: Object.fromEntries(headers),
					contentTypes,
				});
			};
			stage = async (context, next) => {
				const { method } = context.req;
				if ((method !== "GET" && method !== "HEAD") || options.skip?.(context.req.path) === true) {
					return next();
				}
				const rewritten =
					options.rewrite?.({ path: context.req.path, context }) ?? context.req.path;
				const twin = await findTwin(files, context, { twinOf, rewritten });
				const preferred = twin != null && prefersMarkdown(context.req.raw) ? twin : undefined;
				const path = preferred?.path ?? rewritten;
				const file = preferred?.file ?? (await findStaticFile(files, path));
				if (file == null) {
					await next();
				} else {
					context.res = await serve(context, path, file);
				}
				if (twin != null) {
					varyOnAccept(context);
				}
				if (twin != null && preferred == null) {
					linkToTwin(context, twin.path);
				}
			};
		},
		middleware: async (context, next) => (stage == null ? next() : stage(context, next)),
	};
}
