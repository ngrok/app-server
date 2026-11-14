import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SERVER_ENTRY_FILE } from "../core/build-manifest.js";
import { loadEntry } from "./load-entry.js";

/**
 * Where `app-server serve` looks for the server build when no path is given:
 * the server entry in the React Router and Vite output layouts, then a plain
 * React Router build.
 */
export const DEFAULT_BUILD_PATHS = [
	`build/server/${SERVER_ENTRY_FILE}`,
	`dist/server/${SERVER_ENTRY_FILE}`,
	"build/server/index.js",
];

/**
 * Loads the production server build at `buildPath`, a file that exists, and starts it. The copy of
 * this package in the build runs the server when the build has one: see `loadEntry`.
 */
export async function serve({ buildPath }: { buildPath: string }): Promise<void> {
	const build: unknown = await import(pathToFileURL(resolve(buildPath)).href);
	await (await loadEntry(build)).start();
}
