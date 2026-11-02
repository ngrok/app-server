import { Hono } from "hono";
import { describe, expect, it } from "vitest";
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
});
