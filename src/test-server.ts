// Test helper: a prepared app server with a recording log sink and a stub framework.
import { onTestFinished } from "vitest";
import { readBuildManifest } from "./core/build-manifest.js";
import { createServer, serverInternals } from "./core/create-server.js";
import type { AppServer, CreateServerOptions, ServerInternals } from "./core/create-server.js";
import type { FrameworkRuntime, LogLevel, LogSink, Plugin, SetupInfo } from "./core/types.js";
import { nodeFiles } from "./node/files.js";
import { gzipStream } from "./node/gzip.js";

/** One line that the recording sink got. */
export type LoggedLine = {
	level: LogLevel;
	message: string;
	attributes: Readonly<Record<string, unknown>>;
};

const encoder = new TextEncoder();

/** A response that sends `first` at once and the rest when `release` runs. */
export function heldStream(first: string): { response: Response; release: () => void } {
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
export async function renderedFramework(): Promise<Response> {
	return new Response("rendered", { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** A stub framework that renders with `render`. */
export function stubFramework(
	render: FrameworkRuntime["fetch"] = renderedFramework,
	extra: Partial<FrameworkRuntime> = {},
): FrameworkRuntime {
	return { name: "stub", clientDirectory: "/nonexistent", fetch: render, ...extra };
}

/** The setup info of a production server over a client build on disk. */
export async function productionSetup({
	clientDirectory = "/nonexistent",
	framework = stubFramework(),
	logger,
}: {
	clientDirectory?: string;
	framework?: FrameworkRuntime;
	logger: LogSink;
}): Promise<SetupInfo> {
	const files = nodeFiles(clientDirectory);
	const { prerendered, headers } = await readBuildManifest(files);
	return {
		mode: "production",
		files,
		prerenderedPaths: framework.prerenderedPaths ?? prerendered,
		capturedHeaders: new Map(Object.entries(headers)),
		isDataRequest: framework.isDataRequest ?? (() => false),
		contentTypes: framework.contentTypes ?? {},
		gzip: gzipStream,
		logger,
	};
}

/** What {@link testServer} returns. */
type TestServer = {
	app: AppServer;
	internals: ServerInternals;
	framework: FrameworkRuntime;
	lines: LoggedLine[];
	request: (path: string, init?: RequestInit) => Promise<Response>;
};

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
	framework: extra = {},
	options = {},
	routes,
}: {
	plugins: readonly Plugin[];
	clientDirectory?: string;
	prerenderedPaths?: readonly string[];
	render?: FrameworkRuntime["fetch"];
	framework?: Partial<FrameworkRuntime>;
	options?: Omit<CreateServerOptions, "plugins" | "logger">;
	routes?: (app: AppServer) => void;
}): Promise<TestServer> {
	const lines: LoggedLine[] = [];
	const logger: LogSink = {
		log: (level, message, attributes) => {
			lines.push({ level, message, attributes });
		},
	};
	const app = createServer({ ...options, plugins, logger });
	routes?.(app);
	const framework = stubFramework(render, { clientDirectory, prerenderedPaths, ...extra });
	const internals = serverInternals(app);
	if (internals == null) {
		throw new Error("createServer returned an app with no internals.");
	}
	await internals.prepare(await productionSetup({ clientDirectory, framework, logger }));
	return {
		app,
		internals,
		framework,
		lines,
		request: async (path: string, init?: RequestInit) => {
			const response = await app.request(path, init, { framework });
			// Why cancel an unread body: it can hold an open file, and Node.js 26 throws when garbage
			// collection closes a `FileHandle`.
			onTestFinished(async () => {
				if (response.body?.locked === false) {
					await response.body.cancel();
				}
			});
			return response;
		},
	};
}
