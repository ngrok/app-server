import type { NetworkInterfaceInfo } from "node:os";
import { stripVTControlCharacters, styleText } from "node:util";
import { describe, expect, it } from "vitest";
import { devUrlLines, devUrls } from "./dev-urls.js";

function ipv4(address: string): NetworkInterfaceInfo {
	return {
		address,
		family: "IPv4",
		internal: address === "127.0.0.1",
		netmask: "255.255.255.0",
		mac: "00:00:00:00:00:00",
		cidr: null,
	};
}

const interfaces: Record<string, NetworkInterfaceInfo[]> = {
	en0: [ipv4("192.168.4.33")],
	lo0: [ipv4("127.0.0.1"), { ...ipv4("::1"), family: "IPv6", scopeid: 0 }],
	utun5: [ipv4("10.112.0.2")],
};

function lines(
	hostname: string | undefined,
	{ base = "/", on = interfaces }: { base?: string; on?: typeof interfaces } = {},
): string[] {
	return devUrlLines(devUrls({ hostname, port: 3000, base }, on)).map((line) =>
		stripVTControlCharacters(line),
	);
}

describe("devUrls", () => {
	it("gives a loopback host as the one local URL", () => {
		expect(devUrls({ hostname: "127.0.0.1", port: 3000, base: "/" }, interfaces)).toStrictEqual({
			local: ["http://127.0.0.1:3000/"],
			network: [],
			networkInterfaceNames: [],
		});
	});

	it("gives a wildcard host as localhost, then each IPv4 interface with its name", () => {
		expect(devUrls({ hostname: undefined, port: 3000, base: "/docs/" }, interfaces)).toStrictEqual({
			local: ["http://localhost:3000/docs/"],
			network: ["http://192.168.4.33:3000/docs/", "http://10.112.0.2:3000/docs/"],
			networkInterfaceNames: ["en0", "utun5"],
		});
	});

	it("gives a specific host as a network URL, with the name of its interface", () => {
		expect(devUrls({ hostname: "10.112.0.2", port: 3000, base: "/" }, interfaces)).toStrictEqual({
			local: [],
			network: ["http://10.112.0.2:3000/"],
			networkInterfaceNames: ["utun5"],
		});
		expect(
			devUrls({ hostname: "app.test", port: 3000, base: "/" }, interfaces).networkInterfaceNames,
		).toStrictEqual([undefined]);
	});
});

describe("devUrlLines", () => {
	it("prints only the local URL for a loopback host", () => {
		expect(lines("localhost")).toStrictEqual(["  ➜  Local:   http://localhost:3000/"]);
		expect(lines("::1")).toStrictEqual(["  ➜  Local:   http://[::1]:3000/"]);
	});

	it("prints the local URL first, then each IPv4 interface, for a wildcard host", () => {
		const expected = [
			"  ➜  Local:   http://localhost:3000/",
			"  ➜  Network: http://192.168.4.33:3000/  en0",
			"  ➜  Network: http://10.112.0.2:3000/    utun5",
		];
		expect(lines(undefined)).toStrictEqual(expected);
		expect(lines("0.0.0.0")).toStrictEqual(expected);
	});

	it("prints the local URL for a wildcard host with no IPv4 interface", () => {
		const ipv6Only = { lo0: [{ ...ipv4("::1"), family: "IPv6" as const, scopeid: 0 }] };
		expect(lines("::", { on: ipv6Only })).toStrictEqual(["  ➜  Local:   http://localhost:3000/"]);
	});

	it("ends each URL with Vite's base", () => {
		expect(lines("localhost", { base: "/docs/" })).toStrictEqual([
			"  ➜  Local:   http://localhost:3000/docs/",
		]);
	});

	it("prints a network URL with its interface for a specific host", () => {
		expect(lines("10.112.0.2")).toStrictEqual(["  ➜  Network: http://10.112.0.2:3000/  utun5"]);
	});

	it("makes the port of each URL bold, as `vite dev` does", () => {
		const [line = ""] = devUrlLines({ local: ["http://[::1]:3000/docs/"], network: [] });

		expect(line).toContain(`:${styleText("bold", "3000")}/docs/`);
	});
});
