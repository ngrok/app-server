import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Context } from "hono";
import { BUILD_MANIFEST_FILE } from "../core/build-manifest.js";
import type { BuildManifest } from "../core/build-manifest.js";
import type { AppServer } from "../core/create-server.js";
import { createEntry } from "../core/entry.js";
import { requestLogger } from "../core/log.js";
import { withRequestContext as runInRequestContext } from "../core/request-context.js";
import type { AppServerEnv, FrameworkRuntime, RequestContext } from "../core/types.js";
import { host } from "../node/index.js";
import { scriptHashesOf } from "../node/script-hashes.js";

/** Options for {@link createTestServer}. */
export type TestServerOptions = {
	/**
	 * The app from `createServer`. Give each test server a new app, because an
	 * app runs the `setup` of its plugins one time.
	 */
	app: AppServer;
	/**
	 * The files of the client build, by their path in it, such as
	 * `providers/index.html`.
	 */
	files?: Readonly<Record<string, string | Uint8Array>>;
	/**
	 * The framework's answer to a request that no stage answers.
	 * @default a 404
	 */
	framework?: FrameworkRuntime["fetch"];
};

/** What {@link createTestServer} gives. */
export type TestServer = {
	/** Sends a request for `path`, such as `/providers?q=h100`, through the app. */
	request: (path: string, init?: RequestInit) => Promise<Response>;
	/**
	 * Cancels each body that the test did not read, runs each plugin's
	 * `onShutdown`, and removes the client build.
	 */
	close: () => Promise<void>;
};

/** Why: an app runs the `setup` of its plugins one time, so a second test server would get the files of the first. */
const usedApps = new WeakSet<AppServer>();

async function notFound(): Promise<Response> {
	return new Response("Not Found", { status: 404 });
}

/**
 * Starts an app in production mode over a client build of `files`, with no
 * listener. It records the hashes of the inline scripts of each HTML file, as
 * the build does, so `contentSecurityPolicy()` gives a prerendered page its
 * CSP. `requestContext()` and `cspNonce()` work in the framework's answer.
 *
 * @example
 * const server = await createTestServer({
 * 	app: createServer({ plugins: defaultPlugins() }),
 * 	files: { "providers/index.html": "<!doctype html><script>go()</script>" },
 * 	framework: async () => new Response("rendered"),
 * });
 * const response = await server.request("/providers");
 * await server.close();
 */
export async function createTestServer({
	app,
	files = {},
	framework = notFound,
}: TestServerOptions): Promise<TestServer> {
	if (usedApps.has(app)) {
		throw new Error(
			"This app runs in another test server. Give each test server a new app from `createServer()`.",
		);
	}
	usedApps.add(app);
	const clientDirectory = await mkdtemp(join(tmpdir(), "app-server-test-"));
	for (const [path, content] of Object.entries(files)) {
		const file = join(clientDirectory, path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, content);
	}
	const manifest: BuildManifest = {
		prerendered: [],
		headers: {},
		scriptHashes: scriptHashesOf(clientDirectory),
	};
	await writeFile(join(clientDirectory, BUILD_MANIFEST_FILE), JSON.stringify(manifest));
	const entry = createEntry({
		app,
		host,
		clientDirectory,
		framework: () => ({ name: "test", fetch: framework }),
	});
	const responses: Response[] = [];
	return {
		request: async (path, init) => {
			const response = await entry.fetch(new Request(new URL(path, "http://localhost"), init));
			responses.push(response);
			return response;
		},
		close: async () => {
			// Why cancel an unread body: it can hold an open file, and Node.js 26 throws when garbage
			// collection closes a `FileHandle`.
			await Promise.all(
				responses.map(async ({ body }) => (body?.locked === false ? body.cancel() : undefined)),
			);
			await entry.stopPlugins();
			await rm(clientDirectory, { recursive: true, force: true });
		},
	};
}

/**
 * Runs `work` as if in a server request, so `requestContext()` and
 * `cspNonce()` give `values`. Use it to test a render. With no `logger`, the
 * log lines go nowhere.
 *
 * @example
 * const html = await withRequestContext({ cspNonce: "test-nonce" }, () => renderToString(<App />));
 */
export async function withRequestContext<Result>(
	values: Partial<RequestContext>,
	work: () => Result | Promise<Result>,
): Promise<Result> {
	const context = new Context<AppServerEnv>(new Request("http://localhost/"));
	context.set("logger", values.logger ?? requestLogger({ log: () => {} }, context));
	if (values.requestId != null) {
		context.set("requestId", values.requestId);
	}
	if (values.cspNonce != null) {
		context.set("cspNonce", values.cspNonce);
	}
	context.set("clientAddress", values.clientAddress);
	return runInRequestContext(host.storage, context, async () => work());
}
