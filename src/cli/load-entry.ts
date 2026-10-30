import { createServer } from "../core/create-server.js";
import { createEntry, ENTRY_PROTOCOL, isAppServerEntry } from "../core/entry.js";
import type { AppServerEntry } from "../core/entry.js";
import { host } from "../node/index.js";

/** Entries that this copy made for plain React Router builds, by build module. */
const plainEntries = new WeakMap<object, AppServerEntry>();

/**
 * The entry that runs a server build: its `appServer` export when the
 * `appServer` Vite plugin made it, else this copy of the package over a
 * plain React Router build, on the node host, with the default plugins.
 */
export async function loadEntry(build: unknown): Promise<AppServerEntry> {
	if (typeof build !== "object" || build == null) {
		throw new Error("The server build entry is not a module.");
	}
	const exported: unknown = Reflect.get(build, "appServer");
	if (exported != null) {
		if (!isAppServerEntry(exported)) {
			throw new Error(
				`The build's @ngrok/app-server does not use entry protocol ${ENTRY_PROTOCOL}. Install the same version of @ngrok/app-server that the build uses.`,
			);
		}
		return exported;
	}
	const known = plainEntries.get(build);
	if (known != null) {
		return known;
	}
	const { isServerBuild, runtime } = await import("../react-router/index.js");
	if (!isServerBuild(build)) {
		throw new Error("The server build entry is not a React Router server build.");
	}
	const entry = createEntry({
		app: createServer({
			trustForwardedProto: process.env.TRUST_FORWARDED_PROTO === "1",
			trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? 0),
		}),
		host,
		framework: (mode) => runtime(build, { mode }),
	});
	plainEntries.set(build, entry);
	return entry;
}
