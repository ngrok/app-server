import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEntry } from "./entry.js";

/**
 * Loads a production server build and starts it. The copy of this package in
 * the build runs the server when the build has one: see `loadEntry`.
 */
export async function start({ buildPath }: { buildPath: string }): Promise<void> {
	const build: unknown = await import(pathToFileURL(resolve(buildPath)).href);
	await (await loadEntry(build)).start();
}
