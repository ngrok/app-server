import { describe, expect, it } from "vitest";
import { createServer } from "../core/create-server.js";
import { createEntry, ENTRY_PROTOCOL } from "../core/entry.js";
import { host } from "../node/index.js";
import { stubFramework } from "../test-server.js";
import { loadEntry } from "./load-entry.js";

describe("loadEntry", () => {
	it("runs the build's own entry, not one from this copy", async () => {
		const appServer = createEntry({
			app: createServer({ plugins: [] }),
			host,
			framework: () => stubFramework(),
		});

		await expect(loadEntry({ appServer })).resolves.toBe(appServer);
	});

	it("refuses an entry from another protocol version", async () => {
		const appServer = { protocol: ENTRY_PROTOCOL + 1 };

		await expect(loadEntry({ appServer })).rejects.toThrow(
			`does not use entry protocol ${ENTRY_PROTOCOL}`,
		);
	});

	it("refuses a module that is not a React Router build", async () => {
		await expect(loadEntry({ default: {} })).rejects.toThrow("not a React Router server build");
	});
});
