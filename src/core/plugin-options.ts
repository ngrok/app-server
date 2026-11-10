import type { Plugin } from "./types.js";

/**
 * The option of `defaultPlugins()` that places each plugin, by plugin
 * object. Why the object, not the name: an app plugin can have any name.
 */
const options = new WeakMap<Plugin, string>();

/**
 * Marks `plugin` as the plugin of the `option` of `defaultPlugins()`, so
 * `createServer` finds it in the plugin list.
 *
 * @example
 * return optionPlugin("noindex", { name: "noindex", middleware });
 */
export function optionPlugin<P extends Plugin>(option: string, plugin: P): P {
	options.set(plugin, option);
	return plugin;
}

/**
 * Stops startup when `plugins` has two plugins of one option of
 * `defaultPlugins()`, such as two `buildId()`. Why: two copies do not fail.
 * One sets its headers over the other, so a value that the app gave is lost.
 *
 * @example
 * checkOptionPlugins([...defaultPlugins(), buildId({ value: "v42" })]); // throws
 */
export function checkOptionPlugins(plugins: readonly Plugin[]): void {
	const seen = new Set<string>();
	for (const plugin of plugins) {
		const option = options.get(plugin);
		if (option != null && seen.has(option)) {
			throw new Error(
				`The plugin list has the ${plugin.name} plugin two times, so one replaces the other. Keep one: set the "${option}" option of defaultPlugins(), and do not also add the plugin.`,
			);
		}
		if (option != null) {
			seen.add(option);
		}
	}
}

/** The request headers whose presence alone changes the answer of each plugin, by plugin object. */
const presence = new WeakMap<Plugin, readonly string[]>();

/**
 * Marks `plugin` as one whose changes to a response depend only on whether
 * each of `headers` is present in the request. Why: the build can then put
 * one static answer for each case on a CDN, which picks the answer by the
 * same headers.
 *
 * @example
 * return presenceHeaders(["x-ngrok-edge"], { name: "noindex", middleware });
 */
export function presenceHeaders<P extends Plugin>(headers: readonly string[], plugin: P): P {
	presence.set(plugin, headers);
	return plugin;
}

/**
 * The headers that {@link presenceHeaders} marked on `plugins`, in lowercase,
 * once each.
 *
 * @example
 * presenceHeadersOf(defaultPlugins({ noindex: { unlessHeader: "X-Ngrok-Edge" } })); // => ["x-ngrok-edge"]
 */
export function presenceHeadersOf(plugins: readonly Plugin[]): string[] {
	return [
		...new Set(
			plugins.flatMap((plugin) => presence.get(plugin) ?? []).map((name) => name.toLowerCase()),
		),
	];
}
