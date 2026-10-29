import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin, PreviewServer } from "vite";
import {
	//,
	CAPTURED_HEADERS_FILE,
	capturedHeadersKey,
	type CapturedHeaders,
} from "./captured-headers.js";

/** The module ID of the server build entry that {@link serverEntry} generates. */
export const SERVER_ENTRY_ID = "virtual:@ngrok/app-server/entry";
const RESOLVED_SERVER_ENTRY_ID = `\0${SERVER_ENTRY_ID}`;

/** The header that turns on Node's header store for a response, so `finish` can read every header. */
const CAPTURE_MARKER = "x-app-server-capture";

/**
 * Headers that describe one transfer, not the resource. The server sets its
 * own, and a cookie must never replay to every visitor. `Vary` is left out
 * because the preview server adds `Vary: Origin` to every response.
 */
const UNCAPTURED_HEADERS = new Set([
	CAPTURE_MARKER,
	"connection",
	"content-encoding",
	"content-length",
	"date",
	"etag",
	"keep-alive",
	"last-modified",
	"set-cookie",
	"transfer-encoding",
	"vary",
]);

/** The source of the server build entry. */
export function serverEntrySource(appModule: string | undefined): string {
	return [
		`export * from "virtual:react-router/server-build";`,
		// Why from the bundle: the adapter must use the same `react-router` copy as the routes.
		`export { createAdapter as appServerAdapter } from "@ngrok/app-server/react-router";`,
		...(appModule == null ? [] : [`export { default as app } from ${JSON.stringify(appModule)};`]),
	].join("\n");
}

/**
 * Records the headers of each non-document prerender response while React
 * Router's prerender pass runs, and writes them to `.headers.json` in the client build
 * when the preview server closes.
 */
function captureHeaders(server: PreviewServer): void {
	const { config } = server;
	const clientDirectory = resolve(
		config.root,
		config.environments.client?.build.outDir ?? config.build.outDir,
	);
	const captured: CapturedHeaders = {};
	server.middlewares.use((request, response, next) => {
		const { pathname } = new URL(request.url ?? "/", "http://localhost");
		// Why: Node keeps the headers that `writeHead` gets readable only when a header was set first.
		response.setHeader(CAPTURE_MARKER, "1");
		response.once("finish", () => {
			// Why skip documents: `entry.server` sets their headers for each request (a nonce, the
			// host), so the headers of the build's request are wrong for every other one.
			const contentType = String(response.getHeader("content-type") ?? "");
			if (
				response.statusCode < 200 ||
				response.statusCode >= 300 ||
				contentType.startsWith("text/html")
			) {
				return;
			}
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(response.getHeaders())) {
				if (!UNCAPTURED_HEADERS.has(name) && value != null) {
					headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
				}
			}
			captured[capturedHeadersKey(pathname)] = headers;
		});
		next();
	});
	server.httpServer.once("close", () => {
		const sorted = Object.fromEntries(
			Object.entries(captured).toSorted(([first], [second]) => first.localeCompare(second)),
		);
		writeFileSync(
			join(clientDirectory, CAPTURED_HEADERS_FILE),
			`${JSON.stringify(sorted, null, "\t")}\n`,
		);
	});
}

/**
 * The Vite plugin for `@ngrok/app-server`. Put it next to `reactRouter()`.
 *
 * - It makes `build/server/index.js` export the app's server (the default
 *   export of `appModule`) next to the React Router build, so the server is
 *   bundled with the app, its path aliases, and its one copy of `react-router`.
 *   The file stays a valid server build.
 * - During React Router's prerender pass, it records the headers of each
 *   prerendered file that is not an HTML document (resource routes and `.data`
 *   files) into `build/client/.headers.json`. The `prerendered` plugin replays
 *   them. A document's headers depend on its request, so they are not recorded.
 *
 * It does not support React Router `serverBundles`.
 *
 * @param appModule - The module whose default export is the app from `createServer`, relative to the Vite root. When omitted, the server uses its default plugins.
 *
 * @example
 * // vite.config.ts
 * export default defineConfig({ plugins: [reactRouter(), serverEntry("./server.ts")] });
 */
export function serverEntry(appModule?: string): Plugin {
	let root = process.cwd();
	return {
		name: "@ngrok/app-server",
		// Why `pre`: React Router reads the SSR input from the config that the plugins before it return.
		enforce: "pre",
		config: (_config, { command }) =>
			command === "build"
				? { environments: { ssr: { build: { rolldownOptions: { input: SERVER_ENTRY_ID } } } } }
				: undefined,
		configResolved: (config) => {
			root = config.root;
		},
		resolveId: (id) => (id === SERVER_ENTRY_ID ? RESOLVED_SERVER_ENTRY_ID : undefined),
		load: (id) =>
			id === RESOLVED_SERVER_ENTRY_ID
				? serverEntrySource(appModule == null ? undefined : resolve(root, appModule))
				: undefined,
		configurePreviewServer: (server) => {
			// Why this flag: React Router sets it for the preview server of its prerender pass only.
			if (process.env.IS_RR_BUILD_REQUEST === "yes") {
				captureHeaders(server);
			}
		},
	};
}
