import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { BUILD_MANIFEST_FILE } from "../core/build-manifest.js";
import type { BuildManifest } from "../core/build-manifest.js";
import type { AppServer } from "../core/create-server.js";
import { createEntry } from "../core/entry.js";
import type { AppServerEntry } from "../core/entry.js";
import { sinkLogger } from "../core/log.js";
import { withRequestContext as runInRequestContext } from "../core/request-context.js";
import type { FrameworkRuntime, RequestContext } from "../core/types.js";
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
	 * The framework's answer to a request that no stage answers. Give the run
	 * side of a framework adapter in its place to also set `isDataRequest`,
	 * `contentTypes`, or `prerenderedPaths`. The client build is always
	 * `files`: the test server ignores a `clientDirectory`.
	 * @default a 404
	 */
	framework?: FrameworkRuntime["fetch"] | FrameworkRuntime;
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

/** Writes `files` and the build manifest into `clientDirectory`, and gives the app's entry over them. */
async function startEntry(
	clientDirectory: string,
	{ app, files, framework }: Required<TestServerOptions>,
): Promise<AppServerEntry> {
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
	return createEntry({
		app,
		host,
		clientDirectory,
		framework: () =>
			typeof framework === "function" ? { name: "test", fetch: framework } : framework,
	});
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
	for (const path of Object.keys(files)) {
		if (isAbsolute(path) || normalize(path).split(sep)[0] === "..") {
			throw new Error(
				`The file "${path}" is outside the client build. Give a relative path in it.`,
			);
		}
	}
	usedApps.add(app);
	const clientDirectory = await mkdtemp(join(tmpdir(), "app-server-test-"));
	let entry: AppServerEntry;
	try {
		entry = await startEntry(clientDirectory, { app, files, framework });
	} catch (error) {
		usedApps.delete(app);
		await rm(clientDirectory, { recursive: true, force: true });
		throw error;
	}
	const responses: Response[] = [];
	return {
		request: async (path, init) => {
			const response = await entry.fetch(new Request(new URL(path, "http://localhost"), init));
			responses.push(response);
			return response;
		},
		close: async () => {
			// Why cancel an unread body: it can hold an open file, and Node.js 26 throws when garbage
			// collection closes a `FileHandle`. Why `allSettled`: the cancel of a body that failed
			// rejects, and the test sees that error when it reads the body.
			await Promise.allSettled(
				responses.map(async ({ body }) => (body?.locked === false ? body.cancel() : undefined)),
			);
			try {
				await entry.stopPlugins();
			} finally {
				await rm(clientDirectory, { recursive: true, force: true });
			}
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
	const scope = {
		context: undefined,
		values: {
			requestId: values.requestId,
			logger: values.logger ?? sinkLogger({ log: () => {} }),
			cspNonce: values.cspNonce,
			clientAddress: values.clientAddress,
		},
	};
	return runInRequestContext(host.storage, scope, async () => work());
}
