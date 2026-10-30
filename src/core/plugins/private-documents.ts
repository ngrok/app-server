import type { Plugin } from "../types.js";

/**
 * Sets `Cache-Control: private, no-cache` on each HTML document that has no
 * `Cache-Control`, so a shared cache never keeps a page that the server
 * rendered for one user. A response with its own `Cache-Control` keeps it.
 *
 * Put it after the static stages, so it sees only the responses of the app's
 * routes and the framework. `defaultPlugins()` puts it last.
 *
 * @example
 * createServer({ plugins: [requestId(), accessLog(), assets(), prerendered(), privateDocuments()] });
 */
export function privateDocuments(): Plugin {
	return {
		name: "private-documents",
		middleware: async (context, next) => {
			await next();
			const { headers } = context.res;
			if (
				!headers.has("Cache-Control") &&
				(headers.get("Content-Type")?.startsWith("text/html") ?? false)
			) {
				// Why `context.header`: it also works on a framework response with immutable headers.
				context.header("Cache-Control", "private, no-cache");
			}
		},
	};
}
