import { randomBytes } from "node:crypto";
import { constants, createDeflateRaw, gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
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

/** `size` random bytes, the same on each run. With `high`, each is from 0x80 to 0xff, so none matches ASCII text. */
function seededBytes(size: number, seed: number, { high = false } = {}): Buffer {
	const buffer = Buffer.alloc(size);
	let state = seed;
	for (let index = 0; index < size; index += 1) {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		const value = Math.floor(state / 65_536);
		buffer[index] = high ? 128 + (value % 128) : value % 256;
	}
	return buffer;
}

/** The bytes of a new raw deflate stream for `value` in one write with `flush`. */
async function rawLength(value: Uint8Array, flush: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const stream = createDeflateRaw({ flush });
		let length = 0;
		stream.on("data", (chunk: Buffer) => {
			length += chunk.byteLength;
		});
		stream.write(value, (error) => {
			stream.destroy();
			if (error == null) {
				resolve(length);
			} else {
				reject(error);
			}
		});
	});
}

/** A `gzipStream` from a new copy of its module, so its pool of zlib streams is empty. */
async function newGzipStream(): Promise<typeof gzipStream> {
	vi.resetModules();
	return (await import("./gzip.js")).gzipStream;
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

	it("sends the right bytes after a client leaves as zlib gives its stream back to the pool", async () => {
		const gzip = await newGzipStream();
		const alone = await bytes(gzip(queued(page)));
		const reader = gzip(queued(page)).getReader();
		// Why the prototype: the pool resets each stream that it takes back, through zlib's `reset`.
		let zlib: { reset: () => void } = Object.getPrototypeOf(createDeflateRaw());
		while (!Object.hasOwn(zlib, "reset")) {
			zlib = Object.getPrototypeOf(zlib);
		}
		const { reset } = zlib;
		const spy = vi.spyOn(zlib, "reset").mockImplementationOnce(function resetThenCancel(
			this: unknown,
		) {
			reset.call(this);
			// Why a microtask: it runs after the stream is in the pool, and before the read ends.
			queueMicrotask(() => {
				void reader.cancel();
			});
		});
		await reader.read().catch(() => undefined);
		spy.mockRestore();

		const after = await bytes(gzip(queued(page)));

		expect(after.equals(alone)).toBe(true);
	});

	it("sends the same bytes for a body after a longer body, whatever byte follows its end there", async () => {
		// Why these bytes: the body ends with "XYZ" and holds "XYZW" before it, and no other bytes
		// match. zlib hashes 4 bytes at the last 3, so it reads the byte after the end. A stream that
		// kept a longer body with "W" there would find the match.
		const body = Buffer.concat([
			seededBytes(1500, 1, { high: true }),
			Buffer.from("XYZW"),
			seededBytes(600, 2, { high: true }),
			Buffer.from("XYZ"),
		]);
		const longer = Buffer.concat([
			seededBytes(body.byteLength, 3, { high: true }),
			Buffer.from("W".repeat(300)),
		]);
		const before = await bytes(gzipStream(queued(body)));

		await bytes(gzipStream(queued(longer)));
		const after = await bytes(gzipStream(queued(body)));

		expect(after.equals(before)).toBe(true);
		expect(gunzipSync(after)).toStrictEqual(body);
	});

	it("sends the same bytes for a body whose output fills the rest of zlib's output buffer", async () => {
		const body = encoder.encode(
			Array.from(
				{ length: 400 },
				(_, row) => `<tr><td>${row}</td><td>${(row * 7919) % 1000}</td></tr>`,
			).join(""),
		);
		const noise = seededBytes(20_000, 4);
		const alone = await bytes((await newGzipStream())(queued(body)));
		for (const flush of [constants.Z_SYNC_FLUSH, constants.Z_FINISH]) {
			// Why: an earlier body whose output leaves exactly the room that this body's output fills.
			const room = constants.Z_DEFAULT_CHUNK - (await rawLength(body, flush));
			let size = room - 40;
			// oxlint-disable-next-line no-await-in-loop -- each size depends on the output of the last.
			while ((await rawLength(noise.subarray(0, size), flush)) < room) {
				size += 1;
			}
			// oxlint-disable-next-line no-await-in-loop -- each run needs an empty pool.
			const gzip = await newGzipStream();
			// oxlint-disable-next-line no-await-in-loop -- the second body reuses the zlib stream of the first.
			await bytes(gzip(queued(noise.subarray(0, size))));
			// oxlint-disable-next-line no-await-in-loop -- see above.
			const after = await bytes(gzip(queued(body)));

			expect(after.equals(alone)).toBe(true);
		}
	});
});
