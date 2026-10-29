import type { Plugin } from "../types.js";

/** Options for {@link buildId}. */
export type BuildIdOptions = {
	/** @default "X-Build-Id" */
	header?: string;
	/** The deployed build, such as the image tag. Read it from the runtime env, not the build. */
	value: string;
};

/**
 * Sets a build ID header on documents and React Router `.data` responses, so
 * a client can see that a deploy happened under it.
 *
 * @example
 * buildId({ value: env.values.PUBLIC_APP_VERSION });
 */
export function buildId({ header = "X-Build-Id", value }: BuildIdOptions): Plugin {
	return {
		name: "build-id",
		middleware: async (context, next) => {
			// Why: a 304 has no `Content-Type`, so a document that did not change on disk must still
			// answer 200 when the build ID changes.
			context.set("etagParts", [...(context.get("etagParts") ?? []), value]);
			await next();
			const isDocument = context.res.headers.get("Content-Type")?.startsWith("text/html") ?? false;
			if (isDocument || context.req.path.endsWith(".data")) {
				context.header(header, value);
			}
		},
	};
}
