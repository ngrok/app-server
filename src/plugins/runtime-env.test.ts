import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { testServer } from "../test-server.js";
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
const splitDocument = () => {
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
};

describe("runtimeEnv", () => {
	it("parses the values with their schema types", () => {
		const env = runtimeEnv(schema, { source: validSource });

		expect(env.values.PORT).toBe(3000);
		expect(env.publicValues).toEqual({ PUBLIC_API_URL: "https://api.example.com/</script>" });
	});

	it("stops startup with a message that names each bad value", async () => {
		const env = runtimeEnv(schema, {
			source: { PORT: "abc", PUBLIC_API_URL: "https://a.example" },
		});

		await expect(testServer({ plugins: [env] })).rejects.toThrow(
			/The environment is not valid:\n {2}PORT: .+\n {2}SESSION_KEY: /,
		);
	});

	it("puts the public values before </head>, escaped, when the tag spans two chunks", async () => {
		const { request } = await testServer({
			plugins: [runtimeEnv(schema, { source: validSource })],
			render: async () => splitDocument(),
		});

		const response = await request("/");

		expect(await response.text()).toBe(
			'<html><head><title>é</title><script id="app-server-public-env" type="application/json">{"PUBLIC_API_URL":"https://api.example.com/\\u003c/script>"}</script></head><body>page</body></html>',
		);
		expect(response.headers.get("Content-Length")).toBeNull();
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
		expect(await response.text()).toContain("app-server-public-env");
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

		expect(await (await request("/")).text()).not.toContain("app-server-public-env");
	});

	it("leaves a response that is not HTML alone", async () => {
		const { request } = await testServer({
			plugins: [runtimeEnv(schema, { source: validSource })],
			render: async () => new Response("</head>", { headers: { "Content-Type": "text/plain" } }),
		});

		expect(await (await request("/")).text()).toBe("</head>");
	});
});
