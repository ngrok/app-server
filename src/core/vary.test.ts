import { describe, expect, it } from "vitest";
import { withVary } from "./vary.js";

describe("withVary", () => {
	it("gives the name alone for no value", () => {
		expect(withVary(null, "Accept")).toBe("Accept");
		expect(withVary("", "Accept")).toBe("Accept");
		expect(withVary("  ", "Accept")).toBe("Accept");
	});

	it("adds the name after the values, and keeps them as they are", () => {
		expect(withVary("Accept", "Accept-Encoding")).toBe("Accept, Accept-Encoding");
		expect(withVary("accept ,Cookie", "Accept-Encoding")).toBe("accept ,Cookie, Accept-Encoding");
		expect(withVary("Accept;x", "Accept")).toBe("Accept;x, Accept");
	});

	it("gives undefined when the value has the name in any case, or `*`", () => {
		const covered = [
			["Accept-Encoding", "Accept-Encoding"],
			["accept-encoding", "Accept-Encoding"],
			["Accept, Accept-Encoding", "accept"],
			["a,b,,C ", "c"],
			["*", "Accept"],
			["Accept , * ", "Cookie"],
		] as const;

		expect(covered.map(([vary, name]) => withVary(vary, name))).toStrictEqual(
			covered.map(() => undefined),
		);
	});
});
