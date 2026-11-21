import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { createServer, defaultPlugins, serverInternals } from "../create-server.js";
import { clientErrorsScript } from "../../client/client-errors-script.js";
import { clientErrorsReactRouter } from "../../client/client-errors.js";
import { productionSetup, stubFramework, testServer } from "../../test-server.js";
import type { LogSink } from "../types.js";
import { assets } from "./static.js";
import { buildId } from "./build-id.js";
import { errors } from "./errors.js";
import type { AppErrorEvent } from "./errors.js";

const CHROMIUM_STACK = [
	"TypeError: Cannot read properties of undefined (reading 'id')",
	"    at Usage (https://example.com/assets/usage-3f9a1c.js:12:34)",
	"    at async https://example.com/assets/entry-8c2e1d.js:5:6",
	"    at async load (https://example.com/assets/chart-aa11bb.js:1:2)",
].join("\n");

const FIREFOX_STACK = [
	"Usage@https://example.com/assets/usage-3f9a1c.js:12:34",
	"@https://example.com/assets/entry-8c2e1d.js:5:6",
	"https://example.com/assets/chart-aa11bb.js:1:2",
].join("\n");

const USER_AGENT = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";

/** A report as the client module posts it, with `fields` in place of the defaults. */
function report(fields: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
	return {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Sec-Fetch-Site": "same-origin",
			"User-Agent": USER_AGENT,
			...headers,
		},
		body: JSON.stringify({
			name: "TypeError",
			message: "Cannot read properties of undefined (reading 'id')",
			stack: CHROMIUM_STACK,
			source: "router",
			path: "/domains/42",
			route: "/domains/:domainId",
			build: "v41",
			...fields,
		}),
	};
}

/** A sink that keeps each event. */
function recordingSink() {
	const events: AppErrorEvent[] = [];
	return {
		events,
		sink: (event: AppErrorEvent) => {
			events.push(event);
		},
	};
}

describe("errors", () => {
	it("gives the sink one event with the frames of a Chromium stack, and answers 204", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({ plugins: [errors({ sink })] });

		const response = await request("/_app/issues", report());

		expect(response.status).toBe(204);
		expect(events).toStrictEqual([
			{
				side: "client",
				name: "TypeError",
				message: "Cannot read properties of undefined (reading 'id')",
				frames: [
					{
						function: "Usage",
						file: "https://example.com/assets/usage-3f9a1c.js",
						line: 12,
						column: 34,
					},
					{
						function: undefined,
						file: "https://example.com/assets/entry-8c2e1d.js",
						line: 5,
						column: 6,
					},
					{
						function: "load",
						file: "https://example.com/assets/chart-aa11bb.js",
						line: 1,
						column: 2,
					},
				],
				source: "router",
				route: "/domains/:domainId",
				path: "/domains/42",
				userAgent: USER_AGENT,
				buildId: "v41",
			},
		]);
	});

	it("takes the report that the inline script sends for the client module", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({ plugins: [errors({ sink })] });
		// The browser globals that the inline script reads.
		const send = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", send);
		vi.stubGlobal("location", { origin: "https://example.com", pathname: "/domains/42" });
		vi.stubGlobal("addEventListener", () => {});
		vi.stubGlobal("document", { currentScript: null });
		// oxlint-disable-next-line no-eval -- the browser runs this text as an inline script.
		globalThis.eval(clientErrorsScript());
		const error = new TypeError("no id");
		error.stack =
			"TypeError: no id\n    at Usage (https://example.com/assets/usage-3f9a1c.js:12:34)";

		clientErrorsReactRouter().onError(error, { pattern: "/domains/:domainId" });
		const [path, init] = send.mock.calls[0] ?? [];
		const headers = new Headers(init?.headers);
		// The headers that a browser adds to the request.
		headers.set("Sec-Fetch-Site", "same-origin");
		headers.set("User-Agent", USER_AGENT);
		const response = await request("/_app/issues", { ...init, headers });
		Reflect.deleteProperty(globalThis, "__appServerErrors");

		expect(path).toBe("/_app/issues");
		expect(response.status).toBe(204);
		expect(events).toStrictEqual([
			{
				side: "client",
				name: "TypeError",
				message: "no id",
				frames: [
					{
						function: "Usage",
						file: "https://example.com/assets/usage-3f9a1c.js",
						line: 12,
						column: 34,
					},
				],
				source: "router",
				route: "/domains/:domainId",
				path: "/domains/42",
				userAgent: USER_AGENT,
				buildId: undefined,
			},
		]);
	});

	it("reads the frames of a Firefox or Safari stack", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({ plugins: [errors({ sink })] });

		await request(
			"/_app/issues",
			report({ stack: FIREFOX_STACK, source: "error", route: undefined, build: undefined }),
		);

		expect(events[0]?.frames).toStrictEqual([
			{
				function: "Usage",
				file: "https://example.com/assets/usage-3f9a1c.js",
				line: 12,
				column: 34,
			},
			{
				function: undefined,
				file: "https://example.com/assets/entry-8c2e1d.js",
				line: 5,
				column: 6,
			},
			{
				function: undefined,
				file: "https://example.com/assets/chart-aa11bb.js",
				line: 1,
				column: 2,
			},
		]);
		expect([events[0]?.route, events[0]?.buildId]).toStrictEqual([undefined, undefined]);
	});

	it("logs one error line for a report when the app gives no sink", async () => {
		const { request, lines } = await testServer({ plugins: [errors()] });

		await request("/_app/issues", report());

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			level: "error",
			message: "client error",
			attributes: {
				"error.kind": "TypeError",
				"error.message": "Cannot read properties of undefined (reading 'id')",
				"error.stack": [
					"Usage (https://example.com/assets/usage-3f9a1c.js:12:34)",
					"https://example.com/assets/entry-8c2e1d.js:5:6",
					"load (https://example.com/assets/chart-aa11bb.js:1:2)",
				].join("\n"),
				"app_server.client.source": "router",
				"app_server.client.route": "/domains/:domainId",
				"app_server.client.path": "/domains/42",
				"app_server.client.build_id": "v41",
			},
		});
	});

	it("answers 403 to a page of another origin, and gives the sink nothing", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({ plugins: [errors({ sink })] });

		const crossSite = await request("/_app/issues", report({}, { "Sec-Fetch-Site": "cross-site" }));
		const otherOrigin = await request(
			"http://localhost/_app/issues",
			report({}, { "Sec-Fetch-Site": "", Origin: "https://evil.example" }),
		);

		expect([crossSite.status, otherOrigin.status]).toStrictEqual([403, 403]);
		expect(events).toStrictEqual([]);
	});

	it("takes a report with a matching Origin from a browser that sends no Sec-Fetch-Site", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({ plugins: [errors({ sink })] });
		const init = report({}, { Origin: "http://localhost" });
		const headers = new Headers(init.headers);
		headers.delete("Sec-Fetch-Site");

		const taken = await request("http://localhost/_app/issues", { ...init, headers });
		headers.delete("Origin");
		const noOrigin = await request("http://localhost/_app/issues", { ...init, headers });

		// Why the same host: a page on `http:` is another origin than the endpoint on `https:`.
		headers.set("Origin", "http://example.com");
		const otherScheme = await request("https://example.com/_app/issues", { ...init, headers });

		expect([taken.status, noOrigin.status, otherScheme.status]).toStrictEqual([204, 403, 403]);
		expect(events).toHaveLength(1);
	});

	it("answers 413 to a body of more than 6 KiB, by its length and as a stream", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({ plugins: [errors({ sink })] });
		const large = report({ stack: "x".repeat(17_000) });
		const streamed: RequestInit & { duplex: "half" } = {
			...large,
			duplex: "half",
			body: new Response(large.body).body,
		};

		const byLength = await request("/_app/issues", {
			...large,
			headers: { ...large.headers, "Content-Length": String(large.body.length) },
		});
		const asStream = await request("/_app/issues", streamed);

		expect([byLength.status, asStream.status]).toStrictEqual([413, 413]);
		expect(events).toStrictEqual([]);
	});

	it("cancels a streamed body when it passes 6 KiB", async () => {
		const { request } = await testServer({ plugins: [errors()] });
		const { headers } = report();
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(17_000));
			},
			cancel() {
				canceled = true;
			},
		});
		const streamed: RequestInit & { duplex: "half" } = {
			method: "POST",
			headers,
			duplex: "half",
			body,
		};

		const response = await request("/_app/issues", streamed);

		expect(response.status).toBe(413);
		expect(canceled).toBe(true);
	});

	it("answers 413 to a Content-Length of more than 6 KiB before it reads the body", async () => {
		const { request } = await testServer({ plugins: [errors()] });
		const { headers } = report();
		const never: RequestInit & { duplex: "half" } = {
			method: "POST",
			headers: { ...headers, "Content-Length": "7000" },
			duplex: "half",
			body: new ReadableStream<Uint8Array>(),
		};

		const response = await request("/_app/issues", never);

		expect(response.status).toBe(413);
	});

	it("reads a frame whose URL has parentheses or an @", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({ plugins: [errors({ sink })] });

		await request(
			"/_app/issues",
			report({
				stack: [
					"Error: failed",
					"    at load (https://example.com/assets/(group)-3f9a1c.js:1:2)",
					"https://example.com/assets/@scope/a.js:3:4",
					"run@https://example.com/assets/@scope/a.js:5:6",
				].join("\n"),
			}),
		);

		expect(events[0]?.frames).toStrictEqual([
			{
				function: "load",
				file: "https://example.com/assets/(group)-3f9a1c.js",
				line: 1,
				column: 2,
			},
			{ function: undefined, file: "https://example.com/assets/@scope/a.js", line: 3, column: 4 },
			{ function: "run", file: "https://example.com/assets/@scope/a.js", line: 5, column: 6 },
		]);
	});

	it("answers 400 to a body that is not a report", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({ plugins: [errors({ sink })] });

		const statuses = [];
		for (const init of [
			{ ...report(), body: "not json" },
			{ ...report(), body: "null" },
			report({ name: 1 }),
			report({ source: "server" }),
			report({ path: "https://example.com/" }),
			report({ route: 4 }),
		]) {
			statuses.push((await request("/_app/issues", init)).status);
		}

		expect(statuses).toStrictEqual([400, 400, 400, 400, 400, 400]);
		expect(events).toStrictEqual([]);
	});

	it("drops a report from a bot, one with no frame, and one that a file outside the assets threw", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({ plugins: [errors({ sink })] });

		const statuses = [];
		for (const init of [
			report({}, { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }),
			report({}, { "User-Agent": "" }),
			report({ stack: "Error: Script error." }),
			// An inline script that a browser extension adds to the page.
			report({ stack: "Error: x\n    at https://example.com/domains/42:1:100" }),
			report({ stack: "Error: x\n    at go (<anonymous>:1:1)" }),
		]) {
			statuses.push((await request("/_app/issues", init)).status);
		}

		expect(statuses).toStrictEqual([204, 204, 204, 204, 204]);
		expect(events).toStrictEqual([]);
	});

	it("takes a report whose first frame is a source module in development", async () => {
		const { events, sink } = recordingSink();
		const logger: LogSink = { log: () => {} };
		const app = createServer({ plugins: [errors({ sink }), assets()], logger });
		await serverInternals(app)?.prepare({
			...(await productionSetup({ logger })),
			mode: "development",
			devServer: async (_context, next) => next(),
			prerenderedPaths: [],
		});

		const response = await app.request(
			"/_app/issues",
			report({ stack: "Error: x\n    at Home (http://localhost:5173/app/routes/home.tsx:3:9)" }),
			{ framework: stubFramework() },
		);

		expect(response.status).toBe(204);
		expect(events[0]?.frames[0]?.file).toBe("http://localhost:5173/app/routes/home.tsx");
	});

	it("gives the sink no event that the filter refuses", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({
			plugins: [errors({ sink, filter: (event) => event.name !== "AbortError" })],
		});

		await request("/_app/issues", report({ name: "AbortError" }));
		await request("/_app/issues", report());

		expect(events.map((event) => event.name)).toStrictEqual(["TypeError"]);
	});

	it("answers 429 after maxPerMinute reports, and takes reports again in the next minute", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { events, sink } = recordingSink();
		const { request } = await testServer({ plugins: [errors({ sink, maxPerMinute: 2 })] });

		const statuses = [];
		for (let sent = 0; sent < 3; sent += 1) {
			statuses.push((await request("/_app/issues", report())).status);
		}
		vi.advanceTimersByTime(60_000);
		statuses.push((await request("/_app/issues", report())).status);
		vi.useRealTimers();

		expect(statuses).toStrictEqual([204, 204, 429, 204]);
		expect(events).toHaveLength(3);
	});

	it("does not count a report that it drops in maxPerMinute", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({
			plugins: [errors({ sink, maxPerMinute: 1, filter: (event) => event.message !== "noise" })],
		});

		const statuses = [];
		for (const init of [
			report({ stack: "Error: Script error." }),
			report({ message: "noise" }),
			report(),
			report(),
		]) {
			statuses.push((await request("/_app/issues", init)).status);
		}

		expect(statuses).toStrictEqual([204, 204, 204, 429]);
		expect(events).toHaveLength(1);
	});

	it("answers 204 and logs one error line when the sink fails", async () => {
		const { request, lines } = await testServer({
			plugins: [
				errors({
					sink: async () => {
						await Promise.reject(new Error("tracker is down"));
					},
				}),
			],
		});

		const response = await request("/_app/issues", report());

		expect(response.status).toBe(204);
		expect(
			lines.map((line) => [line.level, line.message, line.attributes["error.message"]]),
		).toStrictEqual([["error", "error sink failed", "tracker is down"]]);
	});

	it("answers after 3 seconds and logs one warn line when the sink hangs", async () => {
		vi.useFakeTimers();
		const { request, lines } = await testServer({
			plugins: [errors({ sink: async () => new Promise<void>(() => {}) })],
		});

		const answer = request("/_app/issues", report());
		await vi.advanceTimersByTimeAsync(3000);
		const response = await answer;
		vi.useRealTimers();

		expect(response.status).toBe(204);
		expect(lines.map((line) => [line.level, line.message])).toStrictEqual([
			["warn", "error sink passed the deadline"],
		]);
	});

	it("answers at the clientErrorsPath of the Vite plugin, and sends each other request on to the framework", async () => {
		// The server entry that the Vite plugin generates sets this global.
		vi.stubGlobal("__APP_SERVER_CLIENT_ERRORS_PATH__", "/_x");
		const { events, sink } = recordingSink();
		const { request } = await testServer({ plugins: [errors({ sink })] });

		const taken = await request("/_x", report());
		const defaultPath = await request("/_app/issues", report());
		const get = await request("/_x");

		expect(taken.status).toBe(204);
		await expect(defaultPath.text()).resolves.toBe("rendered");
		await expect(get.text()).resolves.toBe("rendered");
		expect(events).toHaveLength(1);
	});

	it("stops startup for a bad maxPerMinute", () => {
		expect(() => errors({ maxPerMinute: 1.5 })).toThrow(
			"The maxPerMinute of errors must be an integer of 0 or more, not 1.5.",
		);
	});

	it("is off in defaultPlugins() until the app sets the option", async () => {
		const off = await testServer({ plugins: defaultPlugins() });
		const on = await testServer({ plugins: defaultPlugins({ errors: true }) });

		await expect((await off.request("/_app/issues", report())).text()).resolves.toBe("rendered");
		const response = await on.request("/_app/issues", report());

		expect(response.status).toBe(204);
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(on.lines.map((line) => line.message)).toStrictEqual(["client error", "request"]);
	});
});

describe("errors on the server", () => {
	it("gives the sink the error of a 5xx, with its frames and its request, and keeps the answer", async () => {
		const received: { event: AppErrorEvent; url: string }[] = [];
		// Why a message with a line like a frame: V8 puts the message before the frames.
		const thrown = new TypeError("db down\n    at other (/vendor/pool.js:9:9)");
		thrown.stack = `TypeError: ${thrown.message}\n    at load (file:///app/build/server/index.js:12:34)`;
		const { request } = await testServer({
			// Why 0: the limit is for the reports of clients, not for the errors of the server.
			plugins: [
				errors({
					maxPerMinute: 0,
					sink: (event, { request: failed }) => {
						received.push({ event, url: failed.url });
					},
				}),
			],
			render: async () => {
				throw thrown;
			},
		});

		const response = await request("http://localhost/dash?tab=1", {
			headers: { "User-Agent": USER_AGENT },
		});

		expect(response.status).toBe(500);
		await expect(response.text()).resolves.toBe("Internal Server Error");
		expect(received).toStrictEqual([
			{
				event: {
					side: "server",
					source: "pipeline",
					error: thrown,
					name: "TypeError",
					message: thrown.message,
					frames: [
						{ function: "load", file: "file:///app/build/server/index.js", line: 12, column: 34 },
					],
					route: undefined,
					path: "/dash",
					userAgent: USER_AGENT,
					buildId: undefined,
				},
				url: "http://localhost/dash?tab=1",
			},
		]);
		expect(received[0]?.event.side === "server" && received[0].event.error).toBe(thrown);
	});

	it("gives the sink each error that the framework caught, for a 5xx only", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({
			plugins: [errors({ sink })],
			render: async (incoming, context) => {
				const { pathname } = new URL(incoming.url);
				// Why two: a root loader and a child loader can fail in one request.
				context.set("frameworkErrors", [
					new Error(`root failed at ${pathname}`),
					new Error(`child failed at ${pathname}`),
				]);
				return new Response("error boundary", { status: pathname === "/missing" ? 404 : 500 });
			},
		});

		const failed = await request("/dash");
		const missing = await request("/missing");

		expect([failed.status, missing.status]).toStrictEqual([500, 404]);
		expect(events.map(({ side, source, message }) => ({ side, source, message }))).toStrictEqual([
			{ side: "server", source: "framework", message: "root failed at /dash" },
			{ side: "server", source: "framework", message: "child failed at /dash" },
		]);
	});

	it("gives a server event the build that buildId() sends", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({
			plugins: [errors({ sink }), buildId({ value: "release-v42" })],
			render: async () => {
				throw new Error("boom");
			},
		});

		await request("/dash");

		expect(events.map((event) => event.buildId)).toStrictEqual(["release-v42"]);
	});

	it("gives the sink nothing for a thrown 4xx, a 5xx with no error or a 4xx error, or an error that the filter refuses", async () => {
		const { events, sink } = recordingSink();
		const { request } = await testServer({
			plugins: [errors({ sink, filter: (event) => event.message !== "known" })],
			render: async (incoming, context) => {
				const { pathname } = new URL(incoming.url);
				if (pathname === "/forbidden") {
					throw new HTTPException(403);
				}
				if (pathname === "/known") {
					throw new Error("known");
				}
				if (pathname === "/upload") {
					// Why: a framework answers 500 for the 413 of `bodyLimit` that it caught in an action.
					context.set("frameworkErrors", [new HTTPException(413)]);
					return new Response("error boundary", { status: 500 });
				}
				return new Response("busy", { status: 503 });
			},
		});

		const statuses = [
			(await request("/forbidden")).status,
			(await request("/busy")).status,
			(await request("/known")).status,
			(await request("/upload")).status,
		];

		expect(statuses).toStrictEqual([403, 503, 500, 500]);
		expect(events).toStrictEqual([]);
	});

	it("adds no log line for a server error when the app gives no sink", async () => {
		const { request, lines } = await testServer({
			plugins: [errors()],
			render: async () => {
				throw new Error("boom");
			},
		});

		await request("/dash");

		expect(lines.map((line) => line.message)).toStrictEqual(["unhandled error"]);
	});
});
