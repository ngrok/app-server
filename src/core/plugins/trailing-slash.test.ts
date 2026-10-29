import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testServer } from "../../test-server.js";
import { defaultPlugins } from "../create-server.js";
import { prerendered } from "./static.js";
import { trailingSlash } from "./trailing-slash.js";
import type { TrailingSlash } from "./trailing-slash.js";

const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-trailing-slash-"));
const files: Record<string, string> = {
	"index.html": "<h1>Home</h1>",
	"docs/button/index.html": "<h1>Button</h1>",
	"llms.txt": "llms",
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
