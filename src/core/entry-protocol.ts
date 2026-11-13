// Why a module with no import at run time: the CLI checks the `appServer` export of a build with
// it, and that check must not load the server.
import type { AppServerEntry } from "./entry.js";

/** The version of the contract between the CLI and the `appServer` export of a build. */
export const ENTRY_PROTOCOL = 2;

/**
 * Whether a value is an entry of this protocol version.
 *
 * @example
 * isAppServerEntry((await import("./build/server/app-server.js")).appServer); // => true
 */
export function isAppServerEntry(value: unknown): value is AppServerEntry {
	return (
		typeof value === "object" &&
		value != null &&
		"protocol" in value &&
		value.protocol === ENTRY_PROTOCOL
	);
}
