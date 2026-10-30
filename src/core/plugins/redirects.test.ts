import { describe, expect, it } from "vitest";
import { testServer } from "../../test-server.js";
import { defaultPlugins } from "../create-server.js";
import { redirects } from "./redirects.js";
import type { RedirectRule } from "./redirects.js";

async function redirected(rules: RedirectRule[], path: string, init?: RequestInit) {
	const { request } = await testServer({ plugins: [redirects(rules)] });
	const response = await request(path, init);
	return { status: response.status, location: response.headers.get("Location") };
}

describe("redirects", () => {
	it("redirects an exact path, a :param, and a * with the query string", async () => {
		const rules: RedirectRule[] = [
			{ from: "/pricing-old", to: "/pricing" },
			{ from: "/blog/:slug", to: "/articles/:slug", status: 308 },
			{ from: "/docs/*", to: "https://docs.example.com/*" },
		];

		await expect(redirected(rules, "/pricing-old?ref=ad")).resolves.toStrictEqual({
			status: 301,
			location: "/pricing?ref=ad",
		});
		await expect(redirected(rules, "/blog/hello%20world")).resolves.toStrictEqual({
			status: 308,
			location: "/articles/hello%20world",
		});
		await expect(redirected(rules, "/docs/a/b?x=1")).resolves.toStrictEqual({
			status: 301,
			location: "https://docs.example.com/a/b?x=1",
		});
	});

	it("adds the query string to a target that has its own", async () => {
		await expect(
			redirected([{ from: "/old", to: "/new?tab=1" }], "/old?ref=ad"),
		).resolves.toStrictEqual({ status: 301, location: "/new?tab=1&ref=ad" });
	});

	it("goes on for a path with no rule, a POST, and a target that leaves the site", async () => {
		const rules: RedirectRule[] = [
			{ from: "/old", to: "/new" },
			{ from: "/go/*", to: "/*" },
		];

		await expect(redirected(rules, "/other")).resolves.toMatchObject({ status: 200 });
		await expect(redirected(rules, "/old", { method: "POST" })).resolves.toMatchObject({
			status: 200,
		});
		await expect(redirected(rules, "/go//evil.com")).resolves.toMatchObject({ status: 200 });
	});

	it("stops startup for a rule that is not valid", () => {
		expect(() => redirects([{ from: "/a", to: "//evil.com" }])).toThrow("not a safe local path");
		expect(() => redirects([{ from: "/a", to: "/b/:slug" }])).toThrow("does not have");
		expect(() => redirects([{ from: "/a/*/b", to: "/b" }])).toThrow("not the last segment");
		expect(() => redirects([{ from: "/a", to: "ftp://example.com/" }])).toThrow(
			"a local path or an http(s) URL",
		);
	});

	it("sends one redirect from a path with a trailing slash to the final URL", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins({ redirects: [{ from: "/old", to: "/new" }] }),
		});

		const response = await request("/old/");

		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe("/new");
	});
});
