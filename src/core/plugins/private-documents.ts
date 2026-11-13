import { withBuiltInHeaderHook } from "../header-hook.js";
import type { Plugin, SetupInfo } from "../types.js";

/** The data check before `setup` runs. */
function noDataRequests(): boolean {
	return false;
}

/**
 * Sets `Cache-Control: private, no-cache` on each HTML document and each
 * framework data response, such as a React Router `.data` request, that has
 * no `Cache-Control`. A shared cache then never keeps a page or loader data
 * that the server rendered for one user. A response with its own
 * `Cache-Control` keeps it. A resource route that sends per-user JSON sets
 * its own `Cache-Control`.
 *
 * Put it after the static stages, so it sees only the responses of the app's
 * routes and the framework. `defaultPlugins()` puts it last.
 *
 * @example
 * createServer({ plugins: [requestId(), accessLog(), assets(), prerendered(), privateDocuments()] });
 */
export function privateDocuments(): Plugin {
	let isDataRequest: SetupInfo["isDataRequest"] = noDataRequests;
	return {
		name: "private-documents",
		setup: (info) => {
			({ isDataRequest } = info);
		},
		// oxlint-disable-next-line typescript/promise-function-async -- the server awaits each stage in a `try`, and an `async` stage adds a promise to each request.
		middleware: (context, next) =>
			withBuiltInHeaderHook(context, next, (headers) => {
				if (
					!headers.has("Cache-Control") &&
					((headers.get("Content-Type")?.startsWith("text/html") ?? false) ||
						isDataRequest(context.req.path))
				) {
					headers.set("Cache-Control", "private, no-cache");
				}
			}),
	};
}
