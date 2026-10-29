import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEntry } from "./load-entry.js";

/**
 * Where `app-server serve` looks for the server build when no path is given:
 * the node host's entry in the React Router and Vite output layouts, then a
 * plain React Router build.
 */
export const DEFAULT_BUILD_PATHS = [
	"build/server/app-server.js",
	"dist/server/app-server.js",
	"build/server/index.js",
];

/**
 * Loads a production server build and starts it. The copy of this package in
 * the build runs the server when the build has one: see `loadEntry`.
 */
export async function serve({ buildPath }: { buildPath: string | undefined }): Promise<void> {
	const path = buildPath ?? DEFAULT_BUILD_PATHS.find((candidate) => existsSync(candidate));
	if (path == null) {
		throw new Error(
			`No server build found. Build the app, or pass its path. Looked for: ${DEFAULT_BUILD_PATHS.join(", ")}.`,
		);
	}
	const build: unknown = await import(pathToFileURL(resolve(path)).href);
	await (await loadEntry(build)).start();
}
