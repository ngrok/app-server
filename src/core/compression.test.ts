import { describe, expect, it } from "vitest";
import { copyPath } from "./compression.js";

describe("copyPath", () => {
	it("names the copy as a dotfile next to its file", () => {
		expect(copyPath("/assets/app-abc123.js", "br")).toBe("/assets/.app-abc123.js.br");
		expect(copyPath("/docs/button/index.html", "gzip")).toBe("/docs/button/.index.html.gz");
		expect(copyPath("/llms.txt", "gzip")).toBe("/.llms.txt.gz");
	});

	it("changes only the name of the file, also in a dot directory or for a name with a dot first", () => {
		expect(copyPath("/.well-known/security.txt", "br")).toBe("/.well-known/.security.txt.br");
		expect(copyPath("/v1.2/.hidden", "br")).toBe("/v1.2/..hidden.br");
	});
});
