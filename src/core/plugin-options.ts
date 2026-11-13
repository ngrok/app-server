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

/** An HTTP header name: a token of RFC 9110. */
const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/u;

/**
 * A character that a header value cannot hold: a control character other
 * than a tab, or a character above U+00FF. Why this set: it is the rule of
 * the HTTP writer of Node.js, which is the strictest of the hosts.
 */
const NOT_IN_HEADER_VALUE = /[^\t\u0020-\u007E\u0080-\u00FF]/u;

/**
 * Throws when `name`, the `option` of the plugin factory `plugin`, is not an
 * HTTP header name, so a bad option stops startup. Why: such a name starts
 * with no error, and each response that gets the header is then a 500.
 *
 * @example
 * checkHeaderName({ plugin: "requestId", option: "headerName", name: "X Request Id" }); // throws
 */
export function checkHeaderName({
	plugin,
	option,
	name,
}: {
	plugin: string;
	option: string;
	name: string;
}): void {
	if (!HEADER_NAME.test(name)) {
		throw new TypeError(
			`The ${option} of ${plugin} must be an HTTP header name, not ${JSON.stringify(name)}. Use only letters, digits, and "-".`,
		);
	}
}

/**
 * Throws when `value`, the `option` of the plugin factory `plugin`, is not a
 * value that a header can hold, so a bad option stops startup. Why: such a
 * value starts with no error, and each response that gets the header is then
 * a 500.
 *
 * @example
 * checkHeaderValue({ plugin: "buildId", option: "value", value: "v42\n" }); // throws
 */
export function checkHeaderValue({
	plugin,
	option,
	value,
}: {
	plugin: string;
	option: string;
	value: string;
}): void {
	if (NOT_IN_HEADER_VALUE.test(value)) {
		throw new TypeError(
			`The ${option} of ${plugin} must be a value that a header can hold, not ${JSON.stringify(value)}. Remove each control character, such as a line break, and each character above U+00FF.`,
		);
	}
}
