import type { Plugin } from "../types.js";

/**
 * Sets `X-Robots-Tag: noindex, nofollow` on each response, so a search
 * engine does not index a preview deploy. Turn it on from the environment,
 * and put it in `beforeStatic`, so it also sees prerendered pages.
 *
 * @example
 * defaultPlugins({ beforeStatic: process.env.PREVIEW === "1" ? [noindex()] : [] });
 */
export function noindex(): Plugin {
	return {
		name: "noindex",
		middleware: async (context, next) => {
			await next();
			context.header("X-Robots-Tag", "noindex, nofollow");
		},
	};
}
