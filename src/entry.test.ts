import { describe, expect, it } from "vitest";
import { createServer, type AppServer } from "./create-server.js";
import { createEntry, ENTRY_PROTOCOL, loadEntry } from "./entry.js";
import { renderedFramework } from "./test-server.js";

const framework = () => ({
	clientDirectory: "/nonexistent",
	prerenderedPaths: [],
	fetch: renderedFramework,
});

describe("loadEntry", () => {
	it("runs the build's own entry, not one from this copy", async () => {
		const appServer = createEntry({ app: createServer({ plugins: [] }), framework });

		expect(await loadEntry({ appServer })).toBe(appServer);
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

describe("createEntry", () => {
	it("refuses an app that is not from createServer", () => {
		const app = {} as AppServer;

		expect(() => createEntry({ app, framework })).toThrow("not from `createServer()`");
	});

	it("answers a development request through the app's pipeline", async () => {
		const entry = createEntry({ app: createServer({ plugins: [] }), framework });

		const response = await entry.fetchDev(new Request("http://localhost/"), {}, (_, __, next) => {
			next();
		});

		expect(await response.text()).toBe("rendered");
	});
});
