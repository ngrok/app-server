import { withHeaderHook } from "../header-hook.js";
import { optionPlugin } from "../plugin-options.js";
import type { Plugin } from "../types.js";

/**
 * Sets `X-Robots-Tag: noindex, nofollow` on each response, so a search
 * engine does not index a preview deploy. Turn it on from the environment
 * with the `noindex` option of `defaultPlugins()`, which puts it before the
 * static stages, so it also sees prerendered pages.
 *
 * @example
 * defaultPlugins({ noindex: process.env.PREVIEW === "1" });
 */
export function noindex(): Plugin {
	return optionPlugin("noindex", {
		name: "noindex",
		middleware: async (context, next) =>
			withHeaderHook(context, next, (response) => {
				response.set("X-Robots-Tag", "noindex, nofollow");
			}),
	});
}
