import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { testServer } from "../test-server.js";
import { forbidsTransform } from "./compression.js";
import { defaultPlugins } from "./create-server.js";
import { withHeaderHook } from "./header-hook.js";
import type { AppServerEnv } from "./types.js";

describe("withHeaderHook", () => {
	it("keeps the response of the later stages when a hook deletes a header that is not there", async () => {
		const answer = new Response("x");
		const app = new Hono<AppServerEnv>()
			.use(async (context, next) =>
				withHeaderHook(context, next, (response) => {
					response.delete("X-Build-Id");
				}),
			)
			.get("/", () => answer);

		await expect(app.request("/")).resolves.toBe(answer);
	});

	it("leaves a response of an earlier request unchanged when the app sends it again", async () => {
		let cached: Response | undefined;
		const app = new Hono<AppServerEnv>()
			.use(async (context, next) =>
				withHeaderHook(context, next, (response) => {
					response.set("X-Request-Id", context.req.header("X-Request-Id") ?? "");
				}),
			)
			// Why: a plugin that keeps the response after an inner hook copied it.
			.use(async (context, next) => {
				if (cached != null) {
					context.res = cached;
					return;
				}
				await next();
				cached = context.res;
			})
			.use(async (context, next) =>
				withHeaderHook(context, next, (response) => {
					response.set("X-Frame-Options", "DENY");
				}),
			)
			.get("/", () => new Response(null, { status: 204 }));

		const first = await app.request("/", { headers: { "X-Request-Id": "first" } });
		const second = await app.request("/", { headers: { "X-Request-Id": "second" } });

		expect(first.headers.get("X-Request-Id")).toBe("first");
		expect(second.headers.get("X-Request-Id")).toBe("second");
	});

	it("runs the hook of a stage that is not async, and answers its throw as the throw of an async stage", async () => {
		const { request, lines } = await testServer({
			plugins: [
				{
					name: "plain",
					// oxlint-disable-next-line typescript/promise-function-async -- the test needs a stage that is not async.
					middleware: (context, next) => {
						if (context.req.path === "/throws") {
							throw new Error("The stage failed.");
						}
						return withHeaderHook(context, next, (response) => {
							response.set("X-Frame-Options", "DENY");
						});
					},
				},
			],
		});

		const passed = await request("/");
		const thrown = await request("/throws");

		expect(passed.headers.get("X-Frame-Options")).toBe("DENY");
		expect(thrown.status).toBe(500);
		expect(lines).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: "unhandled error",
				attributes: expect.objectContaining({ "error.message": "The stage failed." }),
			}),
		);
	});
});

describe("the header hooks of the default plugins", () => {
	// Why: the static stages and `streamingCompress` run no view for these hooks, so a hook that
	// changes one of these headers would send a body that the headers forbid.
	it("keep no-transform, Content-Encoding, and Content-Range as the response has them", async () => {
		const sent: Record<string, Record<string, string>> = {
			"/page": { "Content-Type": "text/html" },
			"/cached": { "Content-Type": "text/html", "Cache-Control": "public, max-age=60" },
			"/marked": { "Content-Type": "text/plain", "Cache-Control": "public, no-transform" },
			"/encoded": { "Content-Type": "text/plain", "Content-Encoding": "br" },
			"/part": { "Content-Type": "text/plain", "Content-Range": "bytes 0-1/2" },
		};
		const { request } = await testServer({
			plugins: defaultPlugins({
				accessLog: { serverTiming: true },
				noindex: { unlessHeader: "X-Edge" },
				buildId: { value: "b1", paths: () => true },
				contentSecurityPolicy: { policy: ({ scriptSrc }) => `script-src ${scriptSrc}` },
			}),
			render: async (incoming) =>
				new Response("hi", { headers: sent[new URL(incoming.url).pathname] ?? {} }),
		});

		for (const [path, headers] of Object.entries(sent)) {
			const response = await request(path);

			// Why the path: a failure then names the response.
			expect([
				path,
				forbidsTransform(response.headers.get("Cache-Control")),
				response.headers.get("Content-Encoding"),
				response.headers.get("Content-Range"),
			]).toStrictEqual([
				path,
				forbidsTransform(headers["Cache-Control"] ?? null),
				headers["Content-Encoding"] ?? null,
				headers["Content-Range"] ?? null,
			]);
		}
	});
});
