import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { testServer } from "../test-server.js";
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
