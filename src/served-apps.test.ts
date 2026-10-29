import { describe, expect, it, vi } from "vitest";
import { createServer } from "./create-server.js";
import { createEntry, type AppServerEntry } from "./entry.js";
import { servedApps } from "./served-apps.js";
import { renderedFramework } from "./test-server.js";

function entryFor(app = createServer({ plugins: [] })) {
	const entry: AppServerEntry = createEntry({
		app,
		framework: () => ({
			clientDirectory: "/nonexistent",
			prerenderedPaths: [],
			fetch: renderedFramework,
		}),
	});
	return {
		...entry,
		stopPlugins: vi.fn<() => Promise<void>>(entry.stopPlugins),
		abortShutdownSignal: vi.fn<() => void>(),
	};
}

describe("servedApps", () => {
	it("stops a replaced app's plugins once its pending request returns", async () => {
		const apps = servedApps();
		const old = entryFor();
		const { promise: held, resolve: release } = Promise.withResolvers<string>();
		const pending = apps.serve(old, () => held);

		await apps.serve(entryFor(), async () => "new app");
		expect(old.stopPlugins).not.toHaveBeenCalled();
		release("old app");
		await pending;

		expect(old.stopPlugins).toHaveBeenCalledTimes(1);
	});

	it("stops a replaced app at once when it has no pending request", async () => {
		const apps = servedApps();
		const old = entryFor();
		await apps.serve(old, async () => "old app");

		await apps.serve(entryFor(), async () => "new app");

		expect(old.stopPlugins).toHaveBeenCalledTimes(1);
	});

	it("keeps the plugins of an app that a route edit gave a new entry", async () => {
		const apps = servedApps();
		const app = createServer({ plugins: [] });
		const first = entryFor(app);
		await apps.serve(first, async () => "first build");

		await apps.serve(entryFor(app), async () => "second build");

		expect(first.stopPlugins).not.toHaveBeenCalled();
	});

	it("at exit, aborts the signal and stops the plugins of the app it still holds", async () => {
		const apps = servedApps();
		const current = entryFor();
		await apps.serve(current, async () => "current app");

		apps.stopAll();

		expect(current.abortShutdownSignal).toHaveBeenCalledTimes(1);
		expect(current.stopPlugins).toHaveBeenCalledTimes(1);
	});
});
