import type { AppServerEntry } from "./entry.js";

type ServedApp = { entry: AppServerEntry; pending: number; replaced: boolean };

/**
 * Tracks the apps that `app-server start` serves. An edit to `server.ts` makes a
 * new app, and the old app's plugins still hold what their `setup` opened.
 * When the last request that the old app took returns, its `onShutdown` hooks
 * run, and the tracker lets go of it. A route edit makes a new entry with the
 * same app, which keeps its plugins.
 */
export function servedApps() {
	let current: ServedApp | undefined;
	const served = new Set<ServedApp>();
	// Why keep the app until its hooks settle: `stopAll` must wait for hooks that already run.
	// `stopPlugins` runs the hooks once, so a second call only waits.
	const retire = (app: ServedApp) =>
		app.entry.stopPlugins().finally(() => {
			served.delete(app);
		});
	return {
		/** Runs `handle` for a request that `entry` serves. */
		serve: async <Result>(
			entry: AppServerEntry,
			handle: (entry: AppServerEntry) => Promise<Result>,
		): Promise<Result> => {
			if (current?.entry.app === entry.app) {
				current.entry = entry;
			} else {
				if (current != null) {
					current.replaced = true;
					if (current.pending === 0) {
						void retire(current);
					}
				}
				current = { entry, pending: 0, replaced: false };
				served.add(current);
			}
			const app = current;
			app.pending += 1;
			try {
				return await handle(entry);
			} finally {
				app.pending -= 1;
				if (app.replaced && app.pending === 0) {
					void retire(app);
				}
			}
		},
		/**
		 * At exit: aborts `shutdownSignal()` and runs the `onShutdown` hooks of each
		 * app still held. Resolves when the hooks finish or pass the deadline.
		 */
		stopAll: async () => {
			await Promise.all(
				Array.from(served, (app) => {
					app.entry.abortShutdownSignal();
					return retire(app);
				}),
			);
		},
	};
}
