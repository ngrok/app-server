import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createServer, defaultPlugins, serverInternals } from "./create-server.js";
import { logger, requestContext } from "./request-context.js";
import { onResponseSent } from "./response-edge.js";
import { host } from "../node/index.js";
import { tcp } from "../node/tcp.js";
import { collectGarbage, productionSetup, stubFramework } from "../test-server.js";
import { createTestServer, withRequestContext } from "../testing/index.js";
import type {
	FrameworkRuntime,
	LogLine,
	LogSink,
	Plugin,
	RequestContext,
	RequestLogger,
} from "./types.js";

const quiet: LogSink = { log: () => {} };

/** What a transport of {@link transports} gives: a request for `path`, and a promise for the end of its response. */
type Served = { request: (path: string) => Promise<Response>; sent: Promise<undefined> };

/**
 * Each way that a request reaches the app with the request storage of the
 * node host. Why both: the node listener reports the end of a response
 * through its edge, and a request with no listener through a stream around
 * the body.
 */
const transports: {
	transport: string;
	/** The client address of a request on this transport. */
	clientAddress: string | undefined;
	serve: (options: {
		render: FrameworkRuntime["fetch"];
		plugins?: Plugin[];
		logger?: LogSink;
	}) => Promise<Served>;
}[] = [
	{
		transport: "the node listener",
		clientAddress: "127.0.0.1",
		serve: async ({ render, plugins = [], logger: sink = quiet }) => {
			const sent = Promise.withResolvers<undefined>();
			const reportsEnd: Plugin = {
				name: "reports-end",
				middleware: async (context, next) => {
					await next();
					onResponseSent(context, () => {
						sent.resolve(undefined);
					});
				},
			};
			const app = createServer({
				plugins: [...defaultPlugins(), ...plugins, reportsEnd],
				logger: sink,
				listeners: [tcp({ port: 0, host: "127.0.0.1" })],
				shutdownDeadlineMs: 2_000,
			});
			const internals = serverInternals(app);
			internals?.setRequestStore(host.storage);
			await internals?.prepare(await productionSetup({ logger: sink }));
			const server = await internals?.listen(stubFramework(render), []);
			onTestFinished(async () => server?.shutdown());
			return {
				request: async (path) => fetch(new URL(path, server?.urls[0])),
				sent: sent.promise,
			};
		},
	},
	{
		transport: "a request with no listener",
		clientAddress: undefined,
		serve: async ({ render, plugins = [], logger: sink = quiet }) => {
			const sent = Promise.withResolvers<undefined>();
			const reportsEnd: Plugin = {
				name: "reports-end",
				middleware: async (context, next) => {
					await next();
					onResponseSent(context, () => {
						sent.resolve(undefined);
					});
				},
			};
			const server = await createTestServer({
				app: createServer({
					plugins: [...defaultPlugins(), ...plugins, reportsEnd],
					logger: sink,
				}),
				framework: render,
			});
			onTestFinished(server.close);
			return { request: server.request, sent: sent.promise };
		},
	},
];

describe.each(transports)("requestContext on $transport", ({ serve, clientAddress }) => {
	// Why: a timer keeps the request storage of the code that made it, until it fires.
	it("frees the Hono context of a request that left a timer, after its response ends", async () => {
		let context: WeakRef<object> | undefined;
		const timers: NodeJS.Timeout[] = [];
		onTestFinished(() => {
			for (const timer of timers) {
				clearTimeout(timer);
			}
		});
		const { request, sent } = await serve({
			render: async (_request, hono) => {
				context = new WeakRef(hono);
				timers.push(setTimeout(() => {}, 60_000));
				return new Response("rendered");
			},
		});

		await (await request("/page")).text();
		await sent;

		expect(timers).toHaveLength(1);
		// Why not the context in the assertion: a failure would print each field of it.
		await vi.waitFor(() => {
			collectGarbage();
			expect(context?.deref() == null).toBe(true);
		});
	});

	it("gives the values of the request while its body streams, and after its response ends", async () => {
		const lines: LogLine[] = [];
		const firstChunkRead = Promise.withResolvers<undefined>();
		const responseEnded = Promise.withResolvers<undefined>();
		const seen: (Omit<RequestContext, "logger"> | undefined)[] = [];
		const see = (when: string) => {
			const context = requestContext();
			seen.push(
				context == null
					? undefined
					: {
							requestId: context.requestId,
							cspNonce: context.cspNonce,
							clientAddress: context.clientAddress,
						},
			);
			logger().info(when, { "http.method": "caller" });
		};
		let late: Promise<void> | undefined;
		const { request, sent } = await serve({
			logger: {
				log: (line) => {
					lines.push(line);
				},
			},
			plugins: [
				{
					name: "nonce",
					middleware: async (context, next) => {
						context.set("cspNonce", "test-nonce");
						context.set("logAttributes", { trace_id: "trace-1" });
						await next();
					},
				},
			],
			render: async (_request, hono) => {
				see("in the request");
				// Why work that the request starts: it runs in the request storage, as a timer does.
				late = (async () => {
					await responseEnded.promise;
					see("after the response");
				})();
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("first"));
						void (async () => {
							await firstChunkRead.promise;
							hono.set("logAttributes", { trace_id: "trace-2" });
							see("while the body streams");
							controller.close();
						})();
					},
				});
				return new Response(body, { headers: { "Content-Type": "text/plain" } });
			},
		});

		const response = await request("/page");
		const reader = response.body?.getReader();
		await reader?.read();
		firstChunkRead.resolve(undefined);
		await reader?.read();
		await sent;
		responseEnded.resolve(undefined);
		await late;

		const values = {
			requestId: response.headers.get("X-Request-Id"),
			cspNonce: "test-nonce",
			clientAddress,
		};
		expect(seen).toStrictEqual([values, values, values]);
		const line = (message: string, traceId: string) => ({
			level: "info",
			message,
			attributes: {
				"http.request_id": response.headers.get("X-Request-Id"),
				"http.method": "GET",
				"http.url_details.path": "/page",
				trace_id: traceId,
			},
		});
		const written = lines.filter(({ attributes }) => "trace_id" in attributes);
		// Why `trace-2` after the response: the logger keeps the fields that the request had at its end.
		expect(written.filter(({ message }) => message !== "request")).toStrictEqual([
			line("in the request", "trace-1"),
			line("while the body streams", "trace-2"),
			line("after the response", "trace-2"),
		]);
		// Why: a sink that writes the fields in order, such as `jsonSink()`, puts the request ID first.
		expect(written.map(({ attributes }) => Object.keys(attributes)[0])).toStrictEqual(
			written.map(() => "http.request_id"),
		);
	});

	it("keeps a logger that the app set, after the response ends", async () => {
		const appLogger: RequestLogger = { debug() {}, info() {}, warn() {}, error() {} };
		const responseEnded = Promise.withResolvers<undefined>();
		let late: Promise<RequestLogger> | undefined;
		const { request, sent } = await serve({
			plugins: [
				{
					name: "app-logger",
					middleware: async (context, next) => {
						context.set("logger", appLogger);
						await next();
					},
				},
			],
			render: async () => {
				late = (async () => {
					await responseEnded.promise;
					return logger();
				})();
				return new Response("rendered");
			},
		});

		await (await request("/page")).text();
		await sent;
		responseEnded.resolve(undefined);

		await expect(late).resolves.toBe(appLogger);
	});
});

describe("logger", () => {
	it("writes to the sink and hooks of the last createServer call outside a request", () => {
		const lines: LogLine[] = [];
		createServer({ plugins: [], logger: { log: () => {} } });
		createServer({
			plugins: [],
			logger: {
				log: (line) => {
					lines.push(line);
				},
			},
			log: { attributes: ({ attributes }) => ({ ...attributes, app: "web" }) },
		});

		logger().warn("cache cold", { error: new TypeError("miss") });

		expect(lines).toStrictEqual([
			{
				level: "warn",
				message: "cache cold",
				attributes: {
					"error.kind": "TypeError",
					"error.message": "miss",
					"error.stack": expect.any(String),
					app: "web",
				},
			},
		]);
	});

	it("gives the logger of the request inside a request", async () => {
		const requestLog: RequestLogger = { debug() {}, info() {}, warn() {}, error() {} };

		const inside = await withRequestContext({ logger: requestLog }, () => logger());

		expect(inside).toBe(requestLog);
	});
});
