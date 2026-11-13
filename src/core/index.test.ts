import { describe, expect, expectTypeOf, it } from "vitest";
import type { AppServerEntry, CdnPage, StaticPage } from "./index.js";

describe("the exports of @ngrok/app-server", () => {
	// Why: browser code cannot import a value from this entry, because the import pulls the server
	// into the client bundle. The README gives the ID as text.
	it("have no constant for the ID of the public env script", async () => {
		expect(Object.keys(await import("./index.js"))).not.toContain("PUBLIC_ENV_SCRIPT_ID");
	});

	it("name the page that `staticPages()` of an entry yields", () => {
		expectTypeOf<AppServerEntry["staticPages"]>().returns.toEqualTypeOf<
			AsyncGenerator<StaticPage>
		>();
		expectTypeOf<Extract<StaticPage, { cdn: unknown }>["cdn"]>().toEqualTypeOf<CdnPage>();
	});
});
