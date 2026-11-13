import { describe, expect, it } from "vitest";

describe("the exports of @ngrok/app-server/node", () => {
	// Why the whole list: the server entry that `appServer` generates exports this module, so
	// each node-host server build holds the code of each export.
	it("have only what a production server uses", async () => {
		expect(Object.keys(await import("./index.js")).toSorted()).toStrictEqual([
			"host",
			"nodeFiles",
			"parsePort",
			"tcp",
		]);
	});
});
