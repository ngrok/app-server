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

/**
 * The answer to a request whose URL is `url` as it is, with no URL parse.
 * Why: Deno gives the request target as the client sent it, and
 * `new Request` parses it.
 */
async function redirectedAsSent(rules: RedirectRule[], url: string) {
	const { app, framework } = await testServer({ plugins: [redirects(rules)] });
	const request = Object.defineProperty(new Request("http://localhost/"), "url", { value: url });
	const response = await app.fetch(request, { framework });
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

	it("redirects a HEAD request as it does a GET", async () => {
		await expect(
			redirected([{ from: "/old", to: "/new" }], "/old?ref=ad", { method: "HEAD" }),
		).resolves.toStrictEqual({ status: 301, location: "/new?ref=ad" });
	});

	it("adds the query string to a target that has its own", async () => {
		await expect(
			redirected([{ from: "/old", to: "/new?tab=1" }], "/old?ref=ad"),
		).resolves.toStrictEqual({ status: 301, location: "/new?tab=1&ref=ad" });
	});

	it("adds the query string before the fragment of the target", async () => {
		await expect(
			redirected([{ from: "/old", to: "/new#details" }], "/old?ref=ad"),
		).resolves.toStrictEqual({ status: 301, location: "/new?ref=ad#details" });
		await expect(
			redirected([{ from: "/old", to: "/new?tab=1#details" }], "/old?ref=ad"),
		).resolves.toStrictEqual({ status: 301, location: "/new?tab=1&ref=ad#details" });
	});

	it("uses the first rule that matches, whether it is a pattern or an exact path", async () => {
		const rules: RedirectRule[] = [
			{ from: "/blog/:slug", to: "/articles/:slug" },
			{ from: "/blog/old", to: "/archive" },
			{ from: "/news/old", to: "/archive" },
			{ from: "/news/:slug", to: "/updates/:slug" },
		];

		await expect(redirected(rules, "/blog/old")).resolves.toMatchObject({
			location: "/articles/old",
		});
		await expect(redirected(rules, "/news/old")).resolves.toMatchObject({ location: "/archive" });
		await expect(redirected(rules, "/news/new")).resolves.toMatchObject({
			location: "/updates/new",
		});
	});

	it("uses the first rule of the table among the patterns of one first segment and the patterns of each segment", async () => {
		const rules: RedirectRule[] = [
			{ from: "/docs/:page", to: "/first/:page" },
			{ from: "/:section/intro", to: "/second/:section" },
			{ from: "/docs/intro", to: "/third" },
			{ from: "/docs/:page/edit", to: "/fourth/:page" },
			{ from: "/:section/:page/edit", to: "/fifth/:section" },
			{ from: "/blog/*", to: "/sixth/*" },
			{ from: "/*", to: "/seventh/*" },
		];
		const locations = async (paths: string[]) =>
			Promise.all(paths.map(async (path) => (await redirected(rules, path)).location));

		await expect(
			locations([
				"/docs/intro",
				"/guide/intro",
				"/docs/a/edit",
				"/guide/a/edit",
				"/blog/a/b",
				"/x",
			]),
		).resolves.toStrictEqual([
			"/first/intro",
			"/second/guide",
			"/fourth/a",
			"/fifth/guide",
			"/sixth/a/b",
			"/seventh/x",
		]);
		await expect(
			redirected(
				[
					{ from: "/:section/intro", to: "/any/:section" },
					{ from: "/docs/:page", to: "/docs-only/:page" },
				],
				"/docs/intro",
			),
		).resolves.toMatchObject({ location: "/any/docs" });
	});

	it("matches the path as the URL parse gives it, also for a URL that no parse changed", async () => {
		const rules: RedirectRule[] = [
			{ from: "/old", to: "/new" },
			{ from: "/a%7Bb%7D", to: "/braces" },
			{ from: "/A", to: "/upper" },
			{ from: "/a%2Db", to: "/dash" },
		];
		const moved = { status: 301, location: "/new" };

		// Each path is `/old` after the URL parse.
		for (const path of ["/x/../old", "/./old", "/x/%2e%2e/old", String.raw`/x\..\old`]) {
			await expect(redirected(rules, path)).resolves.toStrictEqual(moved);
			await expect(redirectedAsSent(rules, `http://localhost${path}`)).resolves.toStrictEqual(
				moved,
			);
		}
		await expect(redirectedAsSent(rules, "http://localhost/a{b}")).resolves.toStrictEqual({
			status: 301,
			location: "/braces",
		});
		// Why: a rule is the path as it is in the URL, where `%41` is not `A` and `%2D` is not `-`.
		await expect(redirected(rules, "/%41")).resolves.toMatchObject({ status: 200 });
		await expect(redirected(rules, "/a%2Db")).resolves.toMatchObject({ location: "/dash" });
		await expect(redirected(rules, "/A?next=%2Fold")).resolves.toStrictEqual({
			status: 301,
			location: "/upper?next=%2Fold",
		});
	});

	it("matches a rule for a path with an escape when a query comes after it", async () => {
		const rules: RedirectRule[] = [{ from: "/a%2Db", to: "/dash" }];

		// Why these requests: Hono decodes the `%2D`, so the path that it gives is not the path of
		// the rule. A `?` or a second escape after the `%2D` must not change the match.
		await expect(redirected(rules, "/a%2Db?page=2")).resolves.toStrictEqual({
			status: 301,
			location: "/dash?page=2",
		});
		await expect(redirected(rules, "/a%2Db?next=%2Fold")).resolves.toStrictEqual({
			status: 301,
			location: "/dash?next=%2Fold",
		});
	});

	it("goes on for a path with no rule when the request URL does not parse", async () => {
		// Why: the Node.js listener gives such a URL for a `Host: 1.2.3.4.5` header, and a request
		// that matches no rule must not fail on it.
		await expect(
			redirectedAsSent([{ from: "/old", to: "/new" }], "http://1.2.3.4.5/other"),
		).resolves.toStrictEqual({ status: 200, location: null });
	});

	it("goes on for a path with no rule when a URL parse takes a path with a rule from the Host header", async () => {
		const noRedirect = { status: 200, location: null };

		// Why: Deno gives the `Host` header as the client sent it. A URL parse takes the path `/old/`
		// from `http://a\old/`, and the path `/` from a host with a `?` or a `#`.
		await expect(
			redirectedAsSent([{ from: "/old", to: "/new" }], String.raw`http://a\old/`),
		).resolves.toStrictEqual(noRedirect);
		for (const url of ["http://a?b/other", "http://a#b/other"]) {
			await expect(redirectedAsSent([{ from: "/", to: "/home" }], url)).resolves.toStrictEqual(
				noRedirect,
			);
		}
	});

	it("encodes a value in the query of the target, so it stays one value", async () => {
		await expect(
			redirected([{ from: "/search/:term", to: "/results?q=:term" }], "/search/one&two+three"),
		).resolves.toStrictEqual({ status: 301, location: "/results?q=one%26two%2Bthree" });
		await expect(
			redirected([{ from: "/tags/:tag", to: "/tags/:tag/" }], "/tags/a&b"),
		).resolves.toStrictEqual({ status: 301, location: "/tags/a&b/" });
	});

	it("goes on for a request that is already at the target of its rule", async () => {
		const rules: RedirectRule[] = [{ from: "/tags/:tag", to: "/tags/:tag/" }];

		await expect(redirected(rules, "/tags/a")).resolves.toStrictEqual({
			status: 301,
			location: "/tags/a/",
		});
		await expect(redirected(rules, "/tags/a/?page=2")).resolves.toStrictEqual({
			status: 200,
			location: null,
		});
	});

	it("accepts a :splat parameter next to a *", async () => {
		await expect(
			redirected([{ from: "/files/:splat/*", to: "/archive/:splat/*" }], "/files/a/b/c"),
		).resolves.toStrictEqual({ status: 301, location: "/archive/a/b/c" });
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

	it("goes on when the target with the values of the request is not a URL", async () => {
		const rules: RedirectRule[] = [{ from: "/go/*", to: "/*" }];

		// Why these paths: the target is `//%2F` and `//<`, which name a host that no URL can have.
		await expect(redirected(rules, "/go//%2F")).resolves.toStrictEqual({
			status: 200,
			location: null,
		});
		await expect(redirected(rules, "/go//%3C")).resolves.toStrictEqual({
			status: 200,
			location: null,
		});
	});

	it("stops startup for a rule that is not valid", () => {
		expect(() => redirects([{ from: "/a", to: "//evil.com" }])).toThrow("not a safe local path");
		expect(() => redirects([{ from: "/a", to: "/b/:slug" }])).toThrow("does not have");
		expect(() => redirects([{ from: "/a/*/b", to: "/b" }])).toThrow("not the last segment");
		expect(() => redirects([{ from: "/a", to: "ftp://example.com/" }])).toThrow(
			"a local path or an http(s) URL",
		);
	});

	it.each([
		{ from: "/old?page=1", path: "/old" },
		{ from: "/old#top", path: "/old" },
		{ from: "/a b", path: "/a%20b" },
		{ from: "/café", path: "/caf%C3%A9" },
		{ from: "/a/./b", path: "/a/b" },
	])("stops startup for the from $from, which no request path can equal", ({ from, path }) => {
		expect(() => redirects([{ from, to: "/new" }])).toThrow(
			`The redirect from ${from} can never match. A rule matches the path only. Write it percent-encoded, with no query and no fragment: ${path}.`,
		);
	});

	it.each([
		{ from: "/old/:id?", segment: ":id?" },
		{ from: "/blog/:slug*", segment: ":slug*" },
		{ from: "/blog/(.*)", segment: "(.*)" },
		{ from: "/docs/*.html", segment: "*.html" },
	])(
		"stops startup for the from $from, whose segment $segment is a pattern of another server",
		({ from, segment }) => {
			expect(() => redirects([{ from, to: "/new" }])).toThrow(
				`The redirect from ${from} has the segment ${segment}, which is not valid. Use :name for one whole segment, or * as the whole last segment.`,
			);
		},
	);

	it("takes a literal segment with a colon after its start, and a percent-encoded path", async () => {
		const rules: RedirectRule[] = [
			{ from: "/wiki/Category:Foo", to: "/categories/foo" },
			{ from: "/caf%C3%A9", to: "/cafe" },
		];

		await expect(redirected(rules, "/wiki/Category:Foo")).resolves.toStrictEqual({
			status: 301,
			location: "/categories/foo",
		});
		await expect(redirected(rules, "/caf%C3%A9")).resolves.toStrictEqual({
			status: 301,
			location: "/cafe",
		});
	});

	it("matches the bare prefix of a * rule, and the root with /*", async () => {
		const rules: RedirectRule[] = [
			{ from: "/docs/*", to: "https://docs.example.com/*" },
			{ from: "/*", to: "https://new.example.com/*" },
		];

		await expect(redirected(rules, "/docs")).resolves.toStrictEqual({
			status: 301,
			location: "https://docs.example.com/",
		});
		await expect(redirected(rules, "/?x=1")).resolves.toStrictEqual({
			status: 301,
			location: "https://new.example.com/?x=1",
		});
	});

	it("percent-encodes an absolute target as UTF-8", async () => {
		await expect(
			redirected(
				[{ from: "/de/about", to: "https://example.de/über-uns?city=Zürich" }],
				"/de/about",
			),
		).resolves.toStrictEqual({
			status: 301,
			location: "https://example.de/%C3%BCber-uns?city=Z%C3%BCrich",
		});
	});

	it("drops the trailing slash of a local target in the never mode, so no redirect loops", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins({ redirects: [{ from: "/tags/:tag", to: "/tags/:tag/" }] }),
		});

		const atTarget = await request("/tags/a");
		const withSlash = await request("/tags/a/");

		expect(atTarget.status).toBe(200);
		expect(withSlash.status).toBe(301);
		expect(withSlash.headers.get("Location")).toBe("/tags/a");
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
