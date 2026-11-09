import type { Context } from "hono";
import { withHeaderHook } from "../header-hook.js";
import { optionPlugin } from "../plugin-options.js";
import type { AppServerEnv, Plugin } from "../types.js";
import { withVary } from "../vary.js";

/** Options for {@link noindex}. */
export type NoindexOptions = {
	/**
	 * Whether the request gets `X-Robots-Tag`. It runs once for each request.
	 * @default every request
	 */
	when?: (context: Context<AppServerEnv>) => boolean;
	/**
	 * The request headers that `when` reads. The plugin adds them to `Vary` on
	 * each response, so a shared cache keeps one answer for each value.
	 */
	vary?: readonly string[];
};

/**
 * Sets `X-Robots-Tag: noindex, nofollow` on each response that `when`
 * accepts, so a search engine does not index a preview deploy. The
 * `noindex` option of `defaultPlugins()` puts it before the static stages, so
 * it also sees prerendered pages.
 *
 * @example
 * defaultPlugins({ noindex: process.env.PREVIEW === "1" });
 * defaultPlugins({
 * 	noindex: { when: (c) => c.req.header("x-ngrok-edge") == null, vary: ["x-ngrok-edge"] },
 * });
 */
export function noindex({ when, vary = [] }: NoindexOptions = {}): Plugin {
	return optionPlugin("noindex", {
		name: "noindex",
		middleware: async (context, next) => {
			const hidden = when?.(context) ?? true;
			if (!hidden && vary.length === 0) {
				return next();
			}
			await withHeaderHook(context, next, (response) => {
				if (hidden) {
					response.set("X-Robots-Tag", "noindex, nofollow");
				}
				for (const name of vary) {
					const value = withVary(response.get("Vary"), name);
					if (value != null) {
						response.set("Vary", value);
					}
				}
			});
		},
	});
}
