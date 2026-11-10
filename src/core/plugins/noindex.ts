import { withHeaderHook } from "../header-hook.js";
import { optionPlugin, presenceHeaders } from "../plugin-options.js";
import type { Plugin } from "../types.js";
import { withVary } from "../vary.js";

/** Options for {@link noindex}. With no options, each response gets `X-Robots-Tag`. */
export type NoindexOptions = {
	/**
	 * A request with this header gets no `X-Robots-Tag`, and each response
	 * gets the header in `Vary`. The `vercel` host can then serve a
	 * prerendered page from the CDN, which picks the answer by the same header.
	 */
	unlessHeader: string;
};

/**
 * Sets `X-Robots-Tag: noindex, nofollow` on each response, or on each
 * response to a request with no `unlessHeader`, so a search engine does not
 * index a preview deploy.
 *
 * The `noindex` option of `defaultPlugins()` puts it
 * before the static stages, so it also sees prerendered pages.
 *
 * @example
 * defaultPlugins({ noindex: process.env.PREVIEW === "1" });
 * defaultPlugins({ noindex: { unlessHeader: "x-ngrok-edge" } });
 */
export function noindex(options?: NoindexOptions): Plugin {
	const unlessHeader = options?.unlessHeader;
	const plugin = optionPlugin("noindex", {
		name: "noindex",
		middleware: async (context, next) => {
			const hidden = unlessHeader == null || context.req.header(unlessHeader) == null;
			await withHeaderHook(context, next, (response) => {
				if (hidden) {
					response.set("X-Robots-Tag", "noindex, nofollow");
				}
				if (unlessHeader != null) {
					const vary = withVary(response.get("Vary"), unlessHeader);
					if (vary != null) {
						response.set("Vary", vary);
					}
				}
			});
		},
	});
	return unlessHeader == null ? plugin : presenceHeaders([unlessHeader], plugin);
}
