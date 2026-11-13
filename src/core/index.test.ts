import { describe, expect, it } from "vitest";

describe("the exports of @ngrok/app-server", () => {
	// Why: browser code cannot import a value from this entry, because the import pulls the server
	// into the client bundle. The README gives the ID as text.
	it("have no constant for the ID of the public env script", async () => {
		expect(Object.keys(await import("./index.js"))).not.toContain("PUBLIC_ENV_SCRIPT_ID");
	});
});
