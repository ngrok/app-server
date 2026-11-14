import type { IncomingMessage, ServerResponse } from "node:http";
import { withForwardedProto } from "../core/create-server.js";
import type { AppServerEntry } from "../core/entry.js";
import type { FileInfo, HostRuntime, StaticFiles } from "../core/types.js";
import { listedFiles, nodeFiles } from "../node/files.js";
import { host as nodeHost } from "../node/index.js";
import { requestListener } from "../node/response-writer.js";
import { flushLogs, logWriter } from "../node/stdout.js";
import { brotliOnlyOpen, FILE_LIST } from "./brotli-only.js";
import type { FunctionFiles } from "./brotli-only.js";

/**
 * The files that {@link FILE_LIST} names in the client build `disk`, with no
 * other read of the file system: each file with the size from the list and
 * the time of the build, and each directory above a file. Gives `undefined`
 * for a client build with no list.
 */
async function listedBuild(disk: StaticFiles): Promise<StaticFiles | undefined> {
	if ((await disk.stat(FILE_LIST))?.kind !== "file") {
		return undefined;
	}
	const text = await new Response(await disk.open(FILE_LIST)).text();
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `vercel()` of this package wrote the file.
	const { builtAt, files, brotliOnly } = JSON.parse(text) as FunctionFiles;
	const entries = new Map<string, FileInfo>();
	const directory: FileInfo = { kind: "directory" };
	for (const sizes of [files, brotliOnly]) {
		for (const [path, size] of Object.entries(sizes)) {
			entries.set(path, { kind: "file", size, mtimeMs: builtAt });
			// Why stop at a known directory: the directories above it are in `entries` already.
			for (
				let parent = path.slice(0, path.lastIndexOf("/")) || "/";
				!entries.has(parent);
				parent = parent.slice(0, parent.lastIndexOf("/")) || "/"
			) {
				entries.set(parent, directory);
			}
		}
	}
	return listedFiles(entries, brotliOnlyOpen(disk.open, new Set(Object.keys(brotliOnly))));
}

/**
 * The vercel host: one Vercel Function on Node.js. It keeps
 * `requestContext()` in `AsyncLocalStorage`, as the node host does. It has no
 * listeners and no lifecycle: Vercel starts and stops the function, and
 * {@link handler} calls the entry's `fetch`.
 *
 * It serves the files of the client build that the list of `vercel()` names
 * ({@link FILE_LIST}), so a cold start reads one file, not each directory. It
 * reads a file that the function keeps only as a brotli copy through that
 * copy. A client build with no list, such as in development, comes from the
 * file system, as on the node host.
 *
 * Why no gzip: Vercel's CDN compresses each response, with Brotli when the
 * client accepts it.
 *
 * @example
 * export const appServer = createEntry({ app, host, framework: (mode) => runtime(build, { mode }) });
 */
export const host: HostRuntime = {
	files: (clientDirectory) => {
		const disk = nodeFiles(clientDirectory);
		let listed: Promise<StaticFiles | undefined> | undefined;
		// Why once: the list does not change while the function runs.
		const list = async () => {
			listed ??= listedBuild(disk);
			return listed;
		};
		return {
			stat: async (path) => ((await list()) ?? disk).stat(path),
			open: async (path, options) => ((await list()) ?? disk).open(path, options),
			snapshot: async () => (await list()) ?? (await disk.snapshot?.()) ?? disk,
		};
	},
	...(nodeHost.storage == null ? {} : { storage: nodeHost.storage }),
	logWriter,
};

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
	const listener = requestListener(
		async (request, bindings) => {
			const realIp = bindings.incoming?.headers["x-real-ip"];
			return entry.fetch(withForwardedProto(request), {
				...bindings,
				...(typeof realIp === "string" ? { remoteAddress: realIp } : {}),
			});
		},
		{ trustForwardedProto: true },
	);
	return async (incoming, outgoing) => {
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
