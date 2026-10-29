import { describe, expect, it } from "vitest";
import { isSafeLocalPath } from "./safe-local-path.js";

describe("isSafeLocalPath", () => {
	it("accepts a same-origin path with a query, a hash, and percent-encoding", () => {
		const paths = [
			"/",
			"/a/b/c",
			"/components/button?tab=props",
			"/components/button#usage",
			"/a?b=1#c",
			"/caf%C3%A9",
			"/files/hello%20world.txt",
			"/~user/a-b_c.d(e)[f]+g&h",
		];

		expect(paths.filter((path) => !isSafeLocalPath(path))).toStrictEqual([]);
	});

	it("rejects a path that goes to another host", () => {
		const paths = [
			"//evil.com",
			"//evil.com/a",
			"///a",
			String.raw`/\evil.com`,
			String.raw`/\\evil.com`,
			"https://evil.com/a",
			"http://evil.com",
		];

		expect(paths.filter((path) => isSafeLocalPath(path))).toStrictEqual([]);
	});

	it("rejects a scheme, a relative path, and a value with no leading slash", () => {
		const paths = [
			"",
			"a",
			"./a",
			"../a",
			" /a",
			"\t/a",
			// oxlint-disable-next-line no-script-url -- the test checks that the scheme is rejected.
			"javascript:alert(1)",
			// oxlint-disable-next-line no-script-url -- the test checks that the scheme is rejected.
			"JavaScript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"mailto:a@example.com",
			"file:///etc/passwd",
		];

		expect(paths.filter((path) => isSafeLocalPath(path))).toStrictEqual([]);
	});

	it("rejects a control character or a character that is not ASCII", () => {
		const paths = [
			"/a\r\nSet-Cookie: evil=1",
			"/a\nb",
			"/\r",
			"/a\u0000b",
			"/a\u001Fb",
			"/a\u007F",
			"/a\u0080",
			"/café",
			"/rocket\u{1F680}",
			"/a\u202Eb",
			"/a\u200Bb",
		];

		expect(paths.filter((path) => isSafeLocalPath(path))).toStrictEqual([]);
	});
});
