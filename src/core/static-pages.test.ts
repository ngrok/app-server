import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { host } from "../node/index.js";
import { createServer, defaultPlugins } from "./create-server.js";
import type { DefaultPluginsOptions } from "./create-server.js";
import { createEntry } from "./entry.js";
import { withHeaderHook } from "./header-hook.js";
import type { StaticPage } from "./static-pages.js";
import type { Plugin } from "./types.js";

const page = "<!doctype html><title>About</title>";
const aboutPage: Readonly<Record<string, string>> = { "about/index.html": page };

/** The static pages of an app over a client build of `files`, with `paths` as the prerendered paths. */
async function pagesOf(
	options: DefaultPluginsOptions,
	paths: readonly string[],
	files: Readonly<Record<string, string>> = aboutPage,
): Promise<StaticPage[]> {
	const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-static-pages-"));
	onTestFinished(() => {
		rmSync(clientDirectory, { recursive: true, force: true });
	});
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(clientDirectory, path)), { recursive: true });
		writeFileSync(join(clientDirectory, path), content);
	}
	const entry = createEntry({
		app: createServer({ plugins: defaultPlugins(options), logger: { log: () => {} } }),
		host,
		clientDirectory,
		framework: () => ({
			name: "test",
			prerenderedPaths: paths,
			fetch: async () =>
				new Response("rendered", { headers: { "Content-Type": "text/html; charset=utf-8" } }),
		}),
	});
	const pages: StaticPage[] = [];
	for await (const each of entry.staticPages()) {
		pages.push(each);
	}
	return pages;
}

/** A `beforeStatic` plugin that sends a request with no session cookie to `/login`. */
const auth: Plugin = {
	name: "auth",
	middleware: async (context, next) =>
		context.req.header("Cookie")?.includes("session=") === true
			? next()
			: context.redirect("/login", 302),
};

describe("staticPages", () => {
	it("gives a public page its body and the pipeline's headers, with no request ID", async () => {
		const [about] = await pagesOf({}, ["/about"]);

		expect(about).toMatchObject({
			path: "/about",
			cdn: {
				file: "/about/index.html",
				answers: [
					{
						present: [],
						headers: {
							"cache-control": "public, max-age=0, must-revalidate",
							"content-type": "text/html; charset=utf-8",
							"strict-transport-security": "max-age=31536000",
							"x-content-type-options": "nosniff",
						},
					},
				],
			},
		});
		const headers = about != null && "cdn" in about ? about.cdn.answers[0]?.headers : {};
		expect(Object.keys(headers ?? {})).not.toContain("x-request-id");
		expect(Object.keys(headers ?? {})).not.toContain("etag");
		expect(about != null && "cdn" in about ? new TextDecoder().decode(about.cdn.body) : "").toBe(
			page,
		);
	});

	it("keeps a page on the server when an auth check refuses an anonymous request", async () => {
		await expect(pagesOf({ beforeStatic: [auth] }, ["/about"])).resolves.toStrictEqual([
			{ path: "/about", reason: "the status is 302" },
		]);
	});

	it("keeps a page on the server when a plugin marks it private or sets a cookie", async () => {
		const privatePages: Plugin = {
			name: "private",
			middleware: async (context, next) =>
				withHeaderHook(context, next, (headers) => {
					// Why the capitals: cache directives are case-insensitive.
					headers.set("Cache-Control", "Private, No-Cache");
				}),
		};
		const cookie: Plugin = {
			name: "cookie",
			middleware: async (context, next) =>
				withHeaderHook(context, next, (headers) => {
					headers.set("Set-Cookie", "seen=1");
				}),
		};

		await expect(pagesOf({ beforeStatic: [privatePages] }, ["/about"])).resolves.toStrictEqual([
			{ path: "/about", reason: "Cache-Control has Private" },
		]);
		await expect(pagesOf({ beforeStatic: [cookie] }, ["/about"])).resolves.toStrictEqual([
			{ path: "/about", reason: "the answer sets a cookie" },
		]);
	});

	it("keeps a page on the server when its answer changes with the query, the host, or the client", async () => {
		const byQuery = await pagesOf(
			{
				prerendered: {
					rewrite: (path, context) =>
						new URL(context.req.url).search === "" ? path : "/about/index.html",
				},
			},
			["/about"],
		);
		const byHost: Plugin = {
			name: "canonical",
			middleware: async (context, next) =>
				withHeaderHook(context, next, (headers) => {
					headers.set("Link", `<${new URL(context.req.url).origin}/about>; rel="canonical"`);
				}),
		};
		const byHostHeader: Plugin = {
			name: "canonical-host",
			middleware: async (context, next) =>
				withHeaderHook(context, next, (headers) => {
					headers.set("Link", `<https://${context.req.header("Host")}/about>; rel="canonical"`);
				}),
		};

		expect(byQuery).toStrictEqual([
			{
				path: "/about",
				reason: "the answer changes with the host, the client address, or the query",
			},
		]);
		await expect(pagesOf({ beforeStatic: [byHost] }, ["/about"])).resolves.toStrictEqual([
			{ path: "/about", reason: "the link header changes with the request" },
		]);
		await expect(pagesOf({ beforeStatic: [byHostHeader] }, ["/about"])).resolves.toStrictEqual([
			{ path: "/about", reason: "the link header changes with the request" },
		]);
	});

	it("gives each case of a noindex header its own headers, and keeps a noindex `when` on the server", async () => {
		const [declared] = await pagesOf({ noindex: { unlessHeader: "x-ngrok-edge" } }, ["/about"]);
		// Why a `when` that hides each page of the checks: the build cannot see that it shows them on another host.
		const opaque = await pagesOf(
			{ noindex: { when: (c) => new URL(c.req.url).hostname !== "example.com", vary: [] } },
			["/about"],
		);

		const answers = declared != null && "cdn" in declared ? declared.cdn.answers : [];
		expect(answers.map(({ present, headers }) => [present, headers["x-robots-tag"]])).toStrictEqual(
			[
				[[], "noindex, nofollow"],
				[["x-ngrok-edge"], undefined],
			],
		);
		expect(answers.every(({ headers }) => headers.vary?.includes("x-ngrok-edge") === true)).toBe(
			true,
		);
		expect(opaque).toStrictEqual([{ path: "/about", reason: "noindex has a `when` function" }]);
	});

	it("names the markdown twin of a page, and serves the twin from the CDN too", async () => {
		const pages = await pagesOf({ prerendered: { markdownTwins: true } }, ["/about", "/about.md"], {
			"about/index.html": page,
			"about.md": "# About",
		});

		expect(pages.map((each) => ("cdn" in each ? [each.path, each.cdn.twin] : each))).toStrictEqual([
			["/about", "/about.md"],
			["/about.md", undefined],
		]);
	});

	it("keeps a path on the server when it is not a plain path or not a file", async () => {
		await expect(pagesOf({}, ["/caf%C3%A9", "/rendered"])).resolves.toStrictEqual([
			{
				path: "/caf%C3%A9",
				reason: "the path has a character that a CDN route can match two ways",
			},
			{ path: "/rendered", reason: "the answer does not come from a prerendered file" },
		]);
	});
});
