import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { gzipStream } from "./gzip.js";

const encoder = new TextEncoder();
const page = encoder.encode("<li>a row of a page</li>".repeat(300));

/** A source that gives one chunk on each pull, so each chunk is one zlib write. */
function pulled(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const chunk = chunks[index];
				index += 1;
				if (chunk == null) {
					controller.close();
				} else {
					controller.enqueue(chunk);
				}
			},
		},
		{ highWaterMark: 0 },
	);
}

/** A source whose chunk and end are queued, as a body from a string. */
function queued(chunk: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(chunk);
			controller.close();
		},
	});
}

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
	return Buffer.from(await new Response(stream).arrayBuffer());
}

describe("gzipStream", () => {
	it("sends an empty gzip member for a body with no bytes", async () => {
		const body = await bytes(gzipStream(pulled([])));

		expect(gunzipSync(body).byteLength).toBe(0);
	});

	it("sends the same bytes for a streamed body, whatever body it sent before", async () => {
		// Why these bytes: the streamed body has a write boundary at offset 3000. Its next write
		// starts with "Z", the byte of the earlier body at offset 3000, and later repeats the 4
		// bytes at 2997. A zlib stream that kept the earlier body would find that match through it.
		const earlier = encoder.encode(`${".".repeat(3000)}Z${".".repeat(5191)}`);
		const first = encoder.encode(`${"a".repeat(2997)}#Q~`);
		const second = encoder.encode(`Z${"b".repeat(200)}#Q~Z${"b".repeat(51)}`);
		const alone = await bytes(gzipStream(pulled([first, second])));

		await bytes(gzipStream(queued(earlier)));
		const after = await bytes(gzipStream(pulled([first, second])));

		expect(after.equals(alone)).toBe(true);
		expect(gunzipSync(after)).toStrictEqual(Buffer.concat([first, second]));
	});

	it("sends the same bytes for a page, whatever body it sent before", async () => {
		const before = await bytes(gzipStream(queued(page)));

		// Why 64 KiB of random bytes: they fill the whole zlib window.
		await bytes(gzipStream(queued(new Uint8Array(randomBytes(64 * 1024)))));
		const after = await bytes(gzipStream(queued(page)));

		expect(after.equals(before)).toBe(true);
		expect(gunzipSync(after)).toStrictEqual(Buffer.from(page));
	});

	it("sends the right bytes after a client leaves while zlib compresses a page", async () => {
		const before = await bytes(gzipStream(queued(page)));
		const reader = gzipStream(queued(new Uint8Array(randomBytes(64 * 1024)))).getReader();
		const read = reader.read().catch(() => undefined);

		await reader.cancel();
		await read;
		const after = await bytes(gzipStream(queued(page)));

		expect(after.equals(before)).toBe(true);
	});
});
