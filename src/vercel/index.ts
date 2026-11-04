import type { IncomingMessage, ServerResponse } from "node:http";
import { withForwardedProto } from "../core/create-server.js";
import type { AppServerEntry } from "../core/entry.js";
import { flushLogs } from "../core/log.js";
import type { FileInfo, HostRuntime, StaticFiles } from "../core/types.js";
import { host as nodeHost } from "../node/index.js";
import { requestListener } from "../node/response-writer.js";

/**
 * `files` that give each file and directory the modification time
 * `mtimeMs`. Why: the deploy gives each file of the function one fixed time,
 * so a file that changes and keeps its size would keep its ETag. `vercel()`
 * sets `APP_SERVER_BUILT_AT` to the time of the build.
 */
function withModifiedTime(files: StaticFiles, mtimeMs: number): StaticFiles {
	const { snapshot } = files;
	return {
		stat: async (path) => {
			const info: FileInfo | undefined = await files.stat(path);
			return info == null ? undefined : { ...info, mtimeMs };
		},
		open: files.open,
		...(snapshot == null
			? {}
			: { snapshot: async () => withModifiedTime(await snapshot(), mtimeMs) }),
	};
}

/**
 * The vercel host: one Vercel Function on Node.js. It reads the client build
 * from the function's files and keeps `requestContext()` in
 * `AsyncLocalStorage`, as the node host does. It has no listeners and no
 * lifecycle: Vercel starts and stops the function, and {@link handler} calls
 * the entry's `fetch`.
 *
 * Why no gzip: Vercel's CDN compresses each response, with Brotli when the
 * client accepts it.
 *
 * @example
 * export const appServer = createEntry({ app, host, framework: (mode) => runtime(build, { mode }) });
 */
export const host: HostRuntime = {
	name: "vercel",
	files: (clientDirectory) => {
		const files = nodeHost.files(clientDirectory);
		const builtAt = Number(process.env.APP_SERVER_BUILT_AT);
		return Number.isFinite(builtAt) ? withModifiedTime(files, builtAt) : files;
	},
	...(nodeHost.storage == null ? {} : { storage: nodeHost.storage }),
};

/** A `Host` header that a URL keeps as it is: a name or an address, and an optional port. */
const VALID_HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/iu;

/**
 * The function handler for the entry of a server build. The function file
 * that `vercel()` writes exports it.
 *
 * - The scheme comes from `X-Forwarded-Proto`, and the client address from
 *   `X-Real-IP`. Why trust them: Vercel sets both headers on each request,
 *   and replaces a value that the client sends.
 * - The node response writer sends each response, as the node host's
 *   listener does.
 * - The log lines of the request reach stdout before the handler returns.
 *   Why: Vercel can freeze the function after the response, before the next
 *   turn of the event loop writes them.
 *
 * @example
 * export default hostModule.handler(appServer);
 */
export function handler(
	entry: AppServerEntry,
): (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<void> {
	const listener = requestListener(async (request, bindings) => {
		const realIp = bindings.incoming?.headers["x-real-ip"];
		return entry.fetch(withForwardedProto(request), {
			...bindings,
			...(typeof realIp === "string" ? { remoteAddress: realIp } : {}),
		});
	});
	return async (incoming, outgoing) => {
		const { host: authority, "x-forwarded-proto": proto } = incoming.headers;
		// Why an absolute target: `@hono/node-server` takes the scheme from the socket, which is plain
		// HTTP behind Vercel's proxy. A target with the forwarded scheme gives the request its URL at
		// once, so `withForwardedProto` copies no request.
		if (
			(proto === "https" || proto === "http") &&
			authority != null &&
			VALID_HOST.test(authority) &&
			incoming.url?.startsWith("/") === true
		) {
			incoming.url = `${proto}://${authority}${incoming.url}`;
		}
		try {
			await listener(incoming, outgoing);
			// Why wait: the access log writes its line when the response closes, after the listener returns.
			if (!outgoing.closed) {
				await new Promise((resolve) => {
					outgoing.once("close", resolve);
				});
			}
		} finally {
			flushLogs();
			// Why wait: a full pipe keeps the rest of a write in a queue, and a frozen function does not send it.
			if (process.stdout.writableLength > 0) {
				await new Promise((resolve) => {
					process.stdout.write("", resolve);
				});
			}
		}
	};
}
