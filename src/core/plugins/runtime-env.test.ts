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

	it("keeps the ETag of a prerendered page, and answers 304 with no Content-Type to a client that holds it", async () => {
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
		expect([
			again.status,
			again.headers.get("ETag"),
			again.headers.get("Content-Type"),
		]).toStrictEqual([304, etag, null]);
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

describe("runtimeEnv, the bytes of a document", () => {
	const encoder = new TextEncoder();
	const script = String.raw`<script id="app-server-public-env" type="application/json">{"PUBLIC_API_URL":"https://api.example.com/\u003c/script>"}</script>`;
	const bytesOf = (part: string | Uint8Array) =>
		typeof part === "string" ? encoder.encode(part) : part;

	/**
	 * The chunks that a client reads for an HTML document whose body gives one
	 * of `parts` for each pull. `onChunk` runs when the client has a chunk, with
	 * the count of the parts that the body gave by then.
	 */
	async function served(
		parts: readonly (string | Uint8Array)[],
		onChunk: (given: number) => void = () => {},
	): Promise<Buffer[]> {
		let given = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					const part = parts[given];
					if (part == null) {
						controller.close();
					} else {
						given += 1;
						controller.enqueue(bytesOf(part));
					}
				},
			},
			{ highWaterMark: 0 },
		);
		const { request } = await testServer({
			plugins: [runtimeEnv(schema, { source: validSource })],
			render: async () => new Response(body, { headers: { "Content-Type": "text/html" } }),
		});
		const chunks: Buffer[] = [];
		for await (const chunk of (await request("/")).body ?? []) {
			onChunk(given);
			chunks.push(Buffer.from(chunk));
		}
		return chunks;
	}

	it("sends each chunk of a document with no </head> when it comes, not at the end of the body", async () => {
		const parts = ["<p>one</p>", "<p>two</p>", "<p>three</p>"];
		const givenAtChunk: number[] = [];

		const chunks = await served(parts, (given) => {
			givenAtChunk.push(given);
		});

		expect(chunks.map(String)).toStrictEqual(parts);
		expect(givenAtChunk).toStrictEqual([1, 2, 3]);
	});

	it("holds only the end of a chunk that can start </head>, and sends the bytes before it at once", async () => {
		const chunks = await served([
			"<html><head><title>é</title></he",
			"ad><body>page</body></html>",
		]);

		expect(chunks.map(String)).toStrictEqual([
			"<html><head><title>é</title>",
			`${script}</head><body>page</body></html>`,
		]);
	});

	it("sends the end of a chunk that it held when the body ends or the next chunk does not complete the tag", async () => {
		const ended = await served(["<p>text</p></hea"]);
		const other = await served(["<p>text</p></hea", "p></body>"]);

		expect(Buffer.concat(ended).toString()).toBe("<p>text</p></hea");
		expect(Buffer.concat(other).toString()).toBe("<p>text</p></heap></body>");
	});

	it("keeps the end of a chunk that it held when the client moves the bytes of the chunk", async () => {
		// Why `alloc`: the buffer of the chunk is then its own, not a pool that other code reads.
		const first = Buffer.alloc(16, "<html><head></he");

		const chunks = await served([first, "ad></html>"], () => {
			if (!first.buffer.detached) {
				first.buffer.transfer();
			}
		});

		expect(chunks.slice(1).map(String)).toStrictEqual([`${script}</head></html>`]);
	});

	it("sends a body of one chunk as one chunk, and each chunk after the script as it is", async () => {
		const one = await served(["<html><head></head><body>page</body></html>"]);
		const three = await served(["<html><head></head>", "<body>page</body>", "</html>"]);

		expect(one.map(String)).toStrictEqual([`<html><head>${script}</head><body>page</body></html>`]);
		expect(three.map(String)).toStrictEqual([
			`<html><head>${script}</head>`,
			"<body>page</body>",
			"</html>",
		]);
	});

	it("keeps each byte of a document that is not UTF-8", async () => {
		const page = Buffer.from(
			"<html><head><meta charset=iso-8859-1></head><body>café</body></html>",
			"latin1",
		);
		const at = page.indexOf("</head>");

		const sent = Buffer.concat(await served([page]));

		expect(sent.toString("hex")).toBe(
			Buffer.concat([page.subarray(0, at), encoder.encode(script), page.subarray(at)]).toString(
				"hex",
			),
		);
	});

	it("keeps a UTF-8 byte order mark at the start of a document", async () => {
		const mark = Buffer.from("efbbbf", "hex");

		const sent = Buffer.concat(await served([mark, "<html><head></head></html>"]));

		expect(sent.toString("hex")).toBe(
			Buffer.concat([mark, encoder.encode(`<html><head>${script}</head></html>`)]).toString("hex"),
		);
	});

	it("finds the first </head> in each letter case and at each split of the chunks", async () => {
		const documents = [
			"<html><head><title>x</title></head><body>hi</body></html>",
			"<HTML><HEAD><TITLE>X</TITLE></HEAD><BODY>HI</BODY></HTML>",
			"<html><head></HeAd><body></head></body></html>",
			"<header></header></hea</head ><<</</head></head>",
			"日本語</head>日本語",
			"</head>",
			"<p>no end of the head</p></hea",
			"",
		];
		const wrong: string[] = [];

		for (const document of documents) {
			const at = document.toLowerCase().indexOf("</head>");
			const expected =
				at === -1 ? document : `${document.slice(0, at)}${script}${document.slice(at)}`;
			const bytes = encoder.encode(document);
			for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9, 64]) {
				const parts = Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) =>
					bytes.subarray(index * size, (index + 1) * size),
				);
				const sent = Buffer.concat(await served(parts)).toString();
				if (sent !== expected) {
					wrong.push(`${document} in chunks of ${size}: ${sent}`);
				}
			}
		}

		expect(wrong).toStrictEqual([]);
	});

	it("stops the search after 1 MiB, so a longer body with no </head> before it stays as it is", async () => {
		const filler = "x".repeat(65_536);
		const within = [...Array.from({ length: 15 }, () => filler), "</head>"];
		const after = [...Array.from({ length: 17 }, () => filler), "</head>"];

		const found = Buffer.concat(await served(within)).toString();
		const passed = Buffer.concat(await served(after)).toString();

		expect(found.endsWith(`${script}</head>`)).toBe(true);
		expect(passed.endsWith(`${filler}</head>`)).toBe(true);
	});

	it("cancels the body when the client cancels", async () => {
		const canceled = Promise.withResolvers<unknown>();
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(encoder.encode("<p>part</p>"));
				},
				cancel(reason) {
					canceled.resolve(reason);
				},
			},
			{ highWaterMark: 0 },
		);
		const { request } = await testServer({
			plugins: [runtimeEnv(schema, { source: validSource })],
			render: async () => new Response(body, { headers: { "Content-Type": "text/html" } }),
		});
		const reader = (await request("/")).body?.getReader();

		await reader?.read();
		await reader?.cancel("gone");

		await expect(canceled.promise).resolves.toBe("gone");
	});
});
