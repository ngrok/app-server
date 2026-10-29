import { requestId as honoRequestId } from "hono/request-id";
import type { Plugin } from "../types.js";

/** Options for {@link requestId}. */
export type RequestIdOptions = {
	/** @default "X-Request-Id" */
	headerName?: string;
};

/**
 * Gives each request an ID: a valid incoming header (up to 255 word
 * characters, `-`, and `=`), else a new UUID. The ID goes on the response, on
 * every log line, and into the framework's context.
 *
 * @example
 * const app = createServer({ plugins: [requestId()] });
 * const response = await app.request("/", { headers: { "X-Request-Id": "abc-123" } });
 * response.headers.get("X-Request-Id"); // => "abc-123"
 */
export function requestId({ headerName = "X-Request-Id" }: RequestIdOptions = {}): Plugin {
	const assign = honoRequestId({ headerName });
	return {
		name: "request-id",
		middleware: async (context, next) => {
			await assign(context, next);
			// Why set it again: a `Response` that the framework returns replaces the headers set before `next`.
			// `context.header` also copies a response whose headers are immutable.
			const id = context.get("requestId");
			if (id != null) {
				context.header(headerName, id);
			}
		},
	};
}
