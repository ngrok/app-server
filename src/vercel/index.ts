import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { withForwardedProto } from "../core/create-server.js";
import type { AppServerEntry } from "../core/entry.js";
import { flushLogs } from "../core/log.js";
import type { FileInfo, HostRuntime, StaticFiles } from "../core/types.js";
import { host as nodeHost } from "../node/index.js";
import { cancelIfClosed, keepGlobalResponse } from "../node/runtimes/node.js";

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

/**
 * The function handler for the entry of a server build. The function file
 * that `vercel()` writes exports it.
 *
 * - The scheme comes from `X-Forwarded-Proto`, and the client address from
 *   `X-Real-IP`. Why trust them: Vercel sets both headers on each request,
 *   and replaces a value that the client sends.
 * - A response whose client went away gets its body canceled, so its
 *   producer stops.
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
	const listener = keepGlobalResponse(() =>
		getRequestListener(async (request, { incoming, outgoing }) => {
			const realIp = incoming.headers["x-real-ip"];
			const response = await entry.fetch(withForwardedProto(request), {
				remoteAddress: typeof realIp === "string" ? realIp : incoming.socket.remoteAddress,
				incoming,
				outgoing,
			});
			return cancelIfClosed(response, outgoing);
		}),
	);
	return async (incoming, outgoing) => {
		try {
			await listener(incoming, outgoing);
		} finally {
			flushLogs();
		}
	};
}
