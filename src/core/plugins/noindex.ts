import type { Context } from "hono";
import { withHeaderHook } from "../header-hook.js";
import { optionPlugin, presenceHeaders } from "../plugin-options.js";
import type { AppServerEnv, Plugin } from "../types.js";
import { withVary } from "../vary.js";

/** Options for {@link noindex}. With no options, each response gets `X-Robots-Tag`. */
export type NoindexOptions =
	| {
			/**
			 * A request with this header gets no `X-Robots-Tag`, and each response
			 * gets the header in `Vary`. Why prefer it over `when`: the `vercel`
			 * host can then serve a prerendered page from the CDN, which picks the
			 * answer by the same header.
			 */
			unlessHeader: string;
	  }
	| {
			/** Whether the request gets `X-Robots-Tag`. It runs once for each request. */
			when: (context: Context<AppServerEnv>) => boolean;
			/**
			 * The request headers that `when` reads. The plugin adds them to `Vary`
			 * on each response, so a shared cache keeps one answer for each value.
			 */
			vary?: readonly string[];
	  };

/**
 * Sets `X-Robots-Tag: noindex, nofollow` on each response, or on each
 * response that the options select, so a search engine does not index a
 * preview deploy. The `noindex` option of `defaultPlugins()` puts it before
 * the static stages, so it also sees prerendered pages.
 *
 * @example
 * defaultPlugins({ noindex: process.env.PREVIEW === "1" });
 * defaultPlugins({ noindex: { unlessHeader: "x-ngrok-edge" } });
 */
export function noindex(options?: NoindexOptions): Plugin {
	let when: ((context: Context<AppServerEnv>) => boolean) | undefined;
	let vary: readonly string[] = [];
	const unlessHeader =
		options != null && "unlessHeader" in options ? options.unlessHeader : undefined;
	if (unlessHeader != null) {
		when = (context) => context.req.header(unlessHeader) == null;
		vary = [unlessHeader];
	} else if (options != null && "when" in options) {
		({ when, vary = [] } = options);
	}
	const plugin = optionPlugin("noindex", {
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
	return unlessHeader == null ? plugin : presenceHeaders([unlessHeader], plugin);
}
