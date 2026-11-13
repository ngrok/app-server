import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { testServer } from "../../test-server.js";
import type { Plugin } from "../types.js";
import { runtimeEnv } from "./runtime-env.js";
import { prerendered } from "./static.js";

const clientDirectory = mkdtempSync(join(tmpdir(), "app-server-runtime-env-"));
writeFileSync(join(clientDirectory, "index.html"), "<html><head></head><body>page</body></html>");

afterAll(() => {
	rmSync(clientDirectory, { recursive: true, force: true });
});

const schema = z.object({
	PORT: z.coerce.number().int(),
	PUBLIC_API_URL: z.url(),
	SESSION_KEY: z.string().min(8),
});
const validSource = {
	PORT: "3000",
	PUBLIC_API_URL: "https://api.example.com/</script>",
	SESSION_KEY: "secret-key",
};

/** A document whose `</head>` arrives split across two chunks. */
function splitDocument() {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("<html><head><title>é</title></he"));
				controller.enqueue(encoder.encode("ad><body>page</body></html>"));
				controller.close();
			},
		}),
		{ headers: { "Content-Type": "text/html; charset=utf-8", "Content-Length": "60" } },
	);
}

describe("runtimeEnv", () => {
	it("parses the values with their schema types", () => {
		const env = runtimeEnv(schema, { source: validSource });

		expect(env.values.PORT).toBe(3000);
		expect(env.publicValues).toStrictEqual({ PUBLIC_API_URL: "https://api.example.com/</script>" });
	});

	it("sends the values of the publicPrefix option to the browser, and no PUBLIC_ value", async () => {
		const env = runtimeEnv(schema, { source: validSource, publicPrefix: "SESSION_" });
		const { request } = await testServer({
			plugins: [env],
			render: async () =>
				new Response("<html><head></head></html>", { headers: { "Content-Type": "text/html" } }),
		});

		expect(env.publicValues).toStrictEqual({ SESSION_KEY: "secret-key" });
		await expect((await request("/")).text()).resolves.toBe(
			'<html><head><script id="app-server-public-env" type="application/json">{"SESSION_KEY":"secret-key"}</script></head></html>',
		);
	});

	it("stops startup for an empty publicPrefix, which would send each value to the browser", () => {
		expect(() => runtimeEnv(schema, { source: validSource, publicPrefix: "" })).toThrow(
			'runtimeEnv needs a publicPrefix of one character or more, not "".',
		);
	});

	it("stops startup with a message that names each bad value", async () => {
		const env = runtimeEnv(schema, {
			source: { PORT: "abc", PUBLIC_API_URL: "https://a.example" },
		});

		await expect(testServer({ plugins: [env] })).rejects.toThrow(
			/The environment is not valid:\n {2}PORT: .+\n {2}SESSION_KEY: /u,
		);
	});

	it("puts the public values before </head>, escaped, when the tag spans two chunks", async () => {
		const { request } = await testServer({
			plugins: [runtimeEnv(schema, { source: validSource })],
			render: async () => splitDocument(),
		});

		const response = await request("/");

		await expect(response.text()).resolves.toBe(
			String.raw`<html><head><title>é</title><script id="app-server-public-env" type="application/json">{"PUBLIC_API_URL":"https://api.example.com/\u003c/script>"}</script></head><body>page</body></html>`,
		);
		expect(response.headers.get("Content-Length")).toBeNull();
	});

	it("reads nothing from a document that an outer stage drops", async () => {
		let pulls = 0;
		const { request } = await testServer({
			plugins: [
				{
					name: "drop",
					middleware: async (context, next) => {
						await next();
						context.res = new Response("dropped");
					},
				},
				runtimeEnv(schema, { source: validSource }),
			],
			render: async () =>
				new Response(
					new ReadableStream<Uint8Array>(
						{
							pull(controller) {
								pulls += 1;
								controller.enqueue(new TextEncoder().encode("<html><head></head></html>"));
								controller.close();
							},
						},
						{ highWaterMark: 0 },
					),
					{ headers: { "Content-Type": "text/html" } },
				),
		});

		await expect((await request("/")).text()).resolves.toBe("dropped");
		expect(pulls).toBe(0);
	});

	it("drops the ETag of a document it changes, so a 304 cannot keep old values", async () => {
		const { request } = await testServer({
			plugins: [runtimeEnv(schema, { source: validSource })],
			render: async () =>
				new Response("<html><head></head></html>", {
					headers: { "Content-Type": "text/html", ETag: 'W/"1-1"' },
				}),
		});

		expect((await request("/")).headers.get("ETag")).toBeNull();
	});

	it("answers 200 with the values to a client that holds the file's ETag from before them", async () => {
		const before = await testServer({ plugins: [prerendered()], clientDirectory });
		const etag = (await before.request("/")).headers.get("ETag") ?? "";
		const after = await testServer({
			plugins: [runtimeEnv(schema, { source: validSource }), prerendered()],
			clientDirectory,
		});

		const response = await after.request("/", { headers: { "If-None-Match": etag } });

		expect(etag).not.toBe("");
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toContain("app-server-public-env");
	});

	it("keeps the ETag of a prerendered page, and answers 304 to a client that holds it", async () => {
		const { request } = await testServer({
			plugins: [runtimeEnv(schema, { source: validSource }), prerendered()],
			clientDirectory,
		});

		const page = await request("/");
		const etag = page.headers.get("ETag") ?? "";
		const head = await request("/", { method: "HEAD" });
		const again = await request("/", { headers: { "If-None-Match": etag } });

		await expect(page.text()).resolves.toContain("app-server-public-env");
		expect(etag).toMatch(/^W\/"/u);
		expect(head.headers.get("ETag")).toBe(etag);
		expect([again.status, again.headers.get("ETag")]).toStrictEqual([304, etag]);
		await expect(again.text()).resolves.toBe("");
	});

	it("answers 200 with the new values to a client that holds the ETag of other values", async () => {
		const serverWith = async (url: string) =>
			testServer({
				plugins: [
					runtimeEnv(schema, { source: { ...validSource, PUBLIC_API_URL: url } }),
					prerendered(),
				],
				clientDirectory,
			});
		const old = await serverWith("https://old.example.com");
		const etag = (await old.request("/")).headers.get("ETag") ?? "";
		const current = await serverWith("https://new.example.com");

		const response = await current.request("/", { headers: { "If-None-Match": etag } });

		expect(etag).not.toBe("");
		expect(response.status).toBe(200);
		expect(response.headers.get("ETag")).not.toBe(etag);
		await expect(response.text()).resolves.toContain("https://new.example.com");
	});

	it("answers 200 to the ETag of a page whose file changes after it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-server-runtime-env-"));
		onTestFinished(() => {
			rmSync(directory, { recursive: true, force: true });
		});
		writeFileSync(join(directory, "index.html"), "<html><head></head><body>one</body></html>");
		const { request } = await testServer({
			plugins: [runtimeEnv(schema, { source: validSource }), prerendered()],
			clientDirectory: directory,
		});
		const etag = (await request("/")).headers.get("ETag") ?? "";

		writeFileSync(join(directory, "index.html"), "<html><head></head><body>three</body></html>");
		const response = await request("/", { headers: { "If-None-Match": etag } });

		expect(etag).not.toBe("");
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toContain("three");
	});

	it("gives a page the ETag of the server, not one from the headers option, which lacks the values", async () => {
		const { request } = await testServer({
			plugins: [
				runtimeEnv(schema, { source: validSource }),
				prerendered({ headers: () => ({ ETag: '"v1"' }) }),
			],
			clientDirectory,
		});

		const response = await request("/", { headers: { "If-None-Match": '"v1"' } });

		expect(response.status).toBe(200);
		expect(response.headers.get("ETag")).toMatch(/^W\/"/u);
		await expect(response.text()).resolves.toContain("app-server-public-env");
	});

	it("sends no ETag for a page that a stage with rewritesHtml also changes, before or after it", async () => {
		const rewrites: Plugin = {
			name: "rewrites",
			middleware: async (context, next) => {
				context.set("rewritesHtml", true);
				await next();
			},
		};
		const env = () => runtimeEnv(schema, { source: validSource });
		const alone = await testServer({ plugins: [env(), prerendered()], clientDirectory });
		const etag = (await alone.request("/")).headers.get("ETag") ?? "";

		for (const plugins of [
			[env(), rewrites, prerendered()],
			[rewrites, env(), prerendered()],
		]) {
			const { request } = await testServer({ plugins, clientDirectory });
			const response = await request("/", { headers: { "If-None-Match": etag } });

			expect([response.status, response.headers.get("ETag")]).toStrictEqual([200, null]);
			await expect(response.text()).resolves.toContain("app-server-public-env");
		}
		expect(etag).not.toBe("");
	});

	it("drops the file length from HEAD, since GET adds the values", async () => {
		const { request } = await testServer({
			plugins: [runtimeEnv(schema, { source: validSource }), prerendered()],
			clientDirectory,
		});

		const response = await request("/", { method: "HEAD" });

		expect(response.headers.get("Content-Length")).toBeNull();
	});

	it("leaves a document alone when no value is public", async () => {
		const { request } = await testServer({
			plugins: [runtimeEnv(z.object({ SESSION_KEY: z.string() }), { source: validSource })],
			render: async () => splitDocument(),
		});

		await expect((await request("/")).text()).resolves.not.toContain("app-server-public-env");
	});

	it("leaves a partial document alone, so its Content-Range still matches the bytes", async () => {
		const { request } = await testServer({
			plugins: [runtimeEnv(schema, { source: validSource })],
			render: async () =>
				new Response("<head></head>", {
					status: 206,
					headers: { "Content-Type": "text/html", "Content-Range": "bytes 0-12/100" },
				}),
		});

		await expect((await request("/")).text()).resolves.toBe("<head></head>");
	});

	it("leaves a response that is not HTML alone", async () => {
		const { request } = await testServer({
			plugins: [runtimeEnv(schema, { source: validSource })],
			render: async () => new Response("</head>", { headers: { "Content-Type": "text/plain" } }),
		});

		await expect((await request("/")).text()).resolves.toBe("</head>");
	});
});
