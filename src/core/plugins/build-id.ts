import { withHeaderHook } from "../header-hook.js";
import type { Plugin, SetupInfo } from "../types.js";

/** Options for {@link buildId}. */
export type BuildIdOptions = {
	/** @default "X-Build-Id" */
	header?: string;
	/** The deployed build, such as the image tag. Read it from the runtime env, not the build. */
	value: string;
};

/** The data check before `setup` runs. */
function noDataRequests(): boolean {
	return false;
}

/**
 * Sets a build ID header on documents and on the framework's data responses,
 * such as React Router `.data` files, so a client can see that a deploy
 * happened under it.
 *
 * @example
 * buildId({ value: env.values.PUBLIC_APP_VERSION });
 */
export function buildId({ header = "X-Build-Id", value }: BuildIdOptions): Plugin {
	let isDataRequest: SetupInfo["isDataRequest"] = noDataRequests;
	return {
		name: "build-id",
		setup: (info) => {
			({ isDataRequest } = info);
		},
		// Why: a 304 has no `Content-Type`, so a document that did not change on disk must still
		// answer 200 when the build ID changes.
		etagPart: () => value,
		middleware: async (context, next) =>
			withHeaderHook(context, next, (response) => {
				const isDocument = response.get("Content-Type")?.startsWith("text/html") ?? false;
				if (isDocument || isDataRequest(context.req.path)) {
					response.set(header, value);
				}
			}),
	};
}
