import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testServer } from "../../test-server.js";
import { defaultPlugins } from "../create-server.js";
import type { AppServer } from "../create-server.js";
import { prerendered } from "./static.js";
import { trailingSlash } from "./trailing-slash.js";
import type { TrailingSlash } from "./trailing-slash.js";

const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-trailing-slash-"));
const files: Record<string, string> = {
	"index.html": "<h1>Home</h1>",
	"docs/button/index.html": "<h1>Button</h1>",
	"llms.txt": "llms",
	LICENSE: "MIT",
	".well-known/acme-challenge/token": "challenge",
};
for (const [path, content] of Object.entries(files)) {
	mkdirSync(dirname(join(clientDirectory, path)), { recursive: true });
	writeFileSync(join(clientDirectory, path), content);
}

afterAll(() => {
	rmSync(clientDirectory, { recursive: true, force: true });
});

async function serve(mode: TrailingSlash) {
	return testServer({
		plugins: [trailingSlash({ mode }), prerendered()],
		clientDirectory,
		framework: { isDataRequest: (path) => path.startsWith("/_serverFn/") },
	});
}

/** The status and `Location` of the answer to `path`. */
async function answer(
	request: Awaited<ReturnType<typeof serve>>["request"],
	path: string,
	init?: RequestInit,
) {
	const response = await request(path, init);
	return { status: response.status, location: response.headers.get("Location") };
}

/**
 * The status and `Location` of the answer to a request whose URL is `url` as
 * it is, with no URL parse. Why: Deno gives the request target as the client
 * sent it, and `new Request` parses it.
 */
async function answerAsSent({ app, framework }: Awaited<ReturnType<typeof serve>>, url: string) {
	const request = Object.defineProperty(new Request("http://localhost/"), "url", { value: url });
	const response = await app.fetch(request, { framework });
	return { status: response.status, location: response.headers.get("Location") };
}

const page = { status: 200, location: null };

describe("trailingSlash", () => {
	describe("never", () => {
		it("redirects a prerendered and a rendered page to the URL with no slash, and keeps the query", async () => {
			const { request } = await serve("never");

			await expect(answer(request, "/docs/button/")).resolves.toStrictEqual({
				status: 308,
				location: "/docs/button",
			});
			await expect(answer(request, "/docs/button/?tab=props")).resolves.toStrictEqual({
				status: 308,
				location: "/docs/button?tab=props",
			});
			await expect(answer(request, "/docs/button//")).resolves.toStrictEqual({
				status: 308,
				location: "/docs/button",
			});
			await expect(answer(request, "/rendered/")).resolves.toStrictEqual({
				status: 308,
				location: "/rendered",
			});
			await expect(answer(request, "/docs/button/", { method: "HEAD" })).resolves.toStrictEqual({
				status: 308,
				location: "/docs/button",
			});
		});

		it("serves the root and a URL with no slash", async () => {
			const { request } = await serve("never");

			await expect((await request("/")).text()).resolves.toBe("<h1>Home</h1>");
			await expect((await request("/docs/button")).text()).resolves.toBe("<h1>Button</h1>");
		});

		it("keeps the URL encoding of the path in the redirect", async () => {
			const { request } = await serve("never");

			await expect(answer(request, "/caf%C3%A9/")).resolves.toStrictEqual({
				status: 308,
				location: "/caf%C3%A9",
			});
			await expect(answer(request, "/a%3Fb/")).resolves.toStrictEqual({
				status: 308,
				location: "/a%3Fb",
			});
		});
	});

	describe("always", () => {
		it("redirects a page to the URL with a slash, and serves the prerendered page there", async () => {
			const { request } = await serve("always");

			await expect(answer(request, "/docs/button?tab=props")).resolves.toStrictEqual({
				status: 308,
				location: "/docs/button/?tab=props",
			});
			await expect(answer(request, "/docs/button//")).resolves.toStrictEqual({
				status: 308,
				location: "/docs/button/",
			});
			await expect((await request("/docs/button/")).text()).resolves.toBe("<h1>Button</h1>");
		});

		it("adds no slash to a file path", async () => {
			const { request } = await serve("always");

			await expect((await request("/llms.txt")).text()).resolves.toBe("llms");
			await expect((await request("/llms%2Etxt")).text()).resolves.toBe("llms");
			await expect((await request("/LICENSE")).text()).resolves.toBe("MIT");
			await expect((await request("/.well-known/acme-challenge/token")).text()).resolves.toBe(
				"challenge",
			);
			await expect(answer(request, "/page.data")).resolves.toStrictEqual({
				status: 200,
				location: null,
			});
		});
	});

	it("sends no redirect in preserve mode", async () => {
		const { request } = await serve("preserve");

		await expect((await request("/docs/button")).text()).resolves.toBe("<h1>Button</h1>");
		await expect((await request("/docs/button/")).text()).resolves.toBe("<h1>Button</h1>");
	});

	it("hands a POST, a data request, and the root to the next stage", async () => {
		const always = await serve("always");
		const never = await serve("never");

		await expect((await never.request("/docs/button/", { method: "POST" })).text()).resolves.toBe(
			"rendered",
		);
		await expect(answer(always.request, "/_serverFn/abc")).resolves.toStrictEqual({
			status: 200,
			location: null,
		});
		await expect(answer(always.request, "/")).resolves.toStrictEqual({
			status: 200,
			location: null,
		});
	});

	it("sends no redirect for a path that one of the app's own routes matches", async () => {
		const routes = (app: AppServer) => {
			app.get("/livez", (context) => context.text("live"));
			app.get("/health/", (context) => context.text("healthy"));
		};
		const always = await testServer({
			plugins: [trailingSlash({ mode: "always" })],
			clientDirectory,
			routes,
		});
		const never = await testServer({
			plugins: [trailingSlash({ mode: "never" })],
			clientDirectory,
			routes,
		});

		await expect((await always.request("/livez")).text()).resolves.toBe("live");
		await expect((await never.request("/health/")).text()).resolves.toBe("healthy");
		await expect(answer(never.request, "/livez/")).resolves.toStrictEqual({
			status: 308,
			location: "/livez",
		});
	});

	it("reads an encoded slash and an encoded backslash as no slash", async () => {
		const never = await serve("never");
		const always = await serve("always");

		for (const path of ["/a%2F", "/a%2f", "/a%5C", "/a%252F"]) {
			await expect(answer(never.request, path)).resolves.toStrictEqual(page);
			await expect(answer(always.request, path)).resolves.toStrictEqual({
				status: 308,
				location: `${path}/`,
			});
			await expect(answer(never.request, `${path}/`)).resolves.toStrictEqual({
				status: 308,
				location: path,
			});
			await expect(answer(always.request, `${path}/`)).resolves.toStrictEqual(page);
		}
	});

	it("keeps a bad escape in the redirect", async () => {
		const never = await serve("never");
		const always = await serve("always");

		for (const path of ["/%E0%A4%A", "/a%", "/%zz"]) {
			await expect(answer(never.request, path)).resolves.toStrictEqual(page);
			await expect(answer(never.request, `${path}/`)).resolves.toStrictEqual({
				status: 308,
				location: path,
			});
			await expect(answer(always.request, path)).resolves.toStrictEqual({
				status: 308,
				location: `${path}/`,
			});
		}
	});

	it("reads a backslash and a dot segment as the URL parse does, also in a URL that no parse changed", async () => {
		const never = await serve("never");
		const always = await serve("always");
		const toNoSlash = { status: 308, location: "/a" };

		// Each path is `/a/` after the URL parse.
		for (const path of ["/a\\", "/a/.", "/a/%2e", "/a/%2E", "/a/b/..", "/a/b/%2e%2E"]) {
			await expect(answer(never.request, path)).resolves.toStrictEqual(toNoSlash);
			await expect(answer(always.request, path)).resolves.toStrictEqual(page);
			await expect(answerAsSent(never, `http://localhost${path}`)).resolves.toStrictEqual(
				toNoSlash,
			);
			await expect(answerAsSent(always, `http://localhost${path}`)).resolves.toStrictEqual(page);
		}
		// Each path is `/` after the URL parse.
		for (const path of ["/.", "/a/..", "/a/../"]) {
			await expect(answerAsSent(never, `http://localhost${path}`)).resolves.toStrictEqual(page);
			await expect(answerAsSent(always, `http://localhost${path}`)).resolves.toStrictEqual(page);
		}
		// Each path ends with `//` after the URL parse.
		await expect(answerAsSent(always, String.raw`http://localhost/a\/`)).resolves.toStrictEqual({
			status: 308,
			location: "/a/",
		});
		await expect(answerAsSent(always, "http://localhost//./")).resolves.toStrictEqual({
			status: 308,
			location: "/",
		});
	});

	it("serves a path in the mode's form when the request URL does not parse", async () => {
		const never = await serve("never");
		const always = await serve("always");

		// Why: the Node.js listener gives such a URL for a `Host: 1.2.3.4.5` header, and a request
		// that needs no redirect must not fail on it.
		await expect(answerAsSent(never, "http://1.2.3.4.5/docs/button")).resolves.toStrictEqual(page);
		await expect(answerAsSent(always, "http://1.2.3.4.5/docs/button/")).resolves.toStrictEqual(
			page,
		);
	});

	it("trims a long run of slashes in linear time", async () => {
		const { request } = await serve("never");
		const path = `/a${"/".repeat(50_000)}b/`;

		const started = performance.now();
		const response = await request(path);

		expect(response.status).toBe(308);
		expect(performance.now() - started).toBeLessThan(250);
	});

	it("never redirects to another host", async () => {
		const { request } = await serve("never");

		for (const path of ["//evil.com/", String.raw`/\evil.com/`]) {
			await expect(answer(request, path)).resolves.toStrictEqual({ status: 200, location: null });
		}
	});

	it("is on in defaultPlugins with the never mode", async () => {
		const { request } = await testServer({ plugins: defaultPlugins(), clientDirectory });

		await expect(answer(request, "/docs/button/")).resolves.toStrictEqual({
			status: 308,
			location: "/docs/button",
		});
	});
});
