import { describe, expect, it, vi } from "vitest";

describe("the exports of @ngrok/app-server/node", () => {
	// Why the whole list: the server entry that `appServer` generates exports this module, so
	// each node-host server build holds the code of each export.
	it("have only what a production server uses", async () => {
		expect(Object.keys(await import("./index.js")).toSorted()).toStrictEqual(["host", "tcp"]);
	});

	// Why: each node-host server build imports this module at start, on Bun and Deno too. Only
	// the listener of `tcp()` on Node.js uses the response writer and `@hono/node-server`.
	it("does not load the Node.js response writer at import", async () => {
		let loaded = false;
		vi.resetModules();
		vi.doMock(import("./response-writer.js"), () => {
			loaded = true;
			return { requestListener: vi.fn<() => never>() };
		});

		await import("./index.js");

		expect(loaded).toBe(false);
	});
});
