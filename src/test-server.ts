// Test helper: a prepared app server with a recording log sink and a stub framework.
import { createServer, serverInternals, type CreateServerOptions } from "./create-server.js";
import type { FrameworkAdapter, LogLevel, LogSink, Plugin } from "./types.js";

/** One line that the recording sink got. */
export type LoggedLine = {
	level: LogLevel;
	message: string;
	attributes: Readonly<Record<string, unknown>>;
};

const encoder = new TextEncoder();

/** A response that sends `first` at once and the rest when `release` runs. */
export function heldStream(first: string) {
	let held: ReadableStreamDefaultController<Uint8Array> | undefined;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(first));
				held = controller;
			},
		}),
		{ headers: { "Content-Type": "text/html" } },
	);
	const release = () => {
		held?.enqueue(encoder.encode("rest"));
		held?.close();
	};
	return { response, release };
}

/** A framework that answers every request with `rendered` as HTML. */
export const renderedFramework = async (): Promise<Response> =>
	new Response("rendered", { headers: { "Content-Type": "text/html; charset=utf-8" } });

/**
 * Builds and prepares an app server for `app.request` tests.
 *
 * @example
 * const { request, lines } = await testServer({ plugins: [requestId()] });
 * const response = await request("/");
 */
export async function testServer({
	plugins,
	clientDirectory = "/nonexistent",
	prerenderedPaths = [],
	render = renderedFramework,
	options = {},
	routes,
}: {
	plugins: readonly Plugin[];
	clientDirectory?: string;
	prerenderedPaths?: readonly string[];
	render?: FrameworkAdapter["fetch"];
	options?: Omit<CreateServerOptions, "plugins" | "logger">;
	routes?: (app: ReturnType<typeof createServer>) => void;
}) {
	const lines: LoggedLine[] = [];
	const logger: LogSink = {
		log: (level, message, attributes) => {
			lines.push({ level, message, attributes });
		},
	};
	const app = createServer({ ...options, plugins, logger });
	routes?.(app);
	const framework: FrameworkAdapter = { clientDirectory, prerenderedPaths, fetch: render };
	const internals = serverInternals(app);
	if (internals == null) {
		throw new Error("createServer returned an app with no internals.");
	}
	await internals.prepare({ mode: "production", clientDirectory, prerenderedPaths, logger });
	return {
		app,
		internals,
		framework,
		lines,
		request: (path: string, init?: RequestInit) => app.request(path, init, { framework }),
	};
}
