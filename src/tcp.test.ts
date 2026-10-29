import { describe, expect, it } from "vitest";
import { listenerUrl } from "./runtimes/listen-options.js";
import { parsePort } from "./tcp.js";

describe("parsePort", () => {
	it("reads the ends of the port range", () => {
		expect(parsePort("0")).toBe(0);
		expect(parsePort("65535")).toBe(65_535);
	});

	it.each(["65536", "-1", "3.5", "http", ""])(
		"refuses %j with a message that names it",
		(value) => {
			expect(() => parsePort(value)).toThrow(
				`PORT must be an integer from 0 to 65535, not "${value}".`,
			);
		},
	);
});

describe("listenerUrl", () => {
	it("reads a wildcard bind as localhost", () => {
		expect(listenerUrl(undefined, 3000)).toBe("http://localhost:3000/");
		expect(listenerUrl("0.0.0.0", 3000)).toBe("http://localhost:3000/");
		expect(listenerUrl("::", 3000)).toBe("http://localhost:3000/");
	});

	it("brackets an IPv6 address", () => {
		expect(listenerUrl("::1", 3000)).toBe("http://[::1]:3000/");
		expect(listenerUrl("127.0.0.1", 3000)).toBe("http://127.0.0.1:3000/");
	});
});
