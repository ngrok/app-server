import { randomBytes } from "node:crypto";
import {
	brotliCompressSync,
	brotliDecompressSync,
	constants,
	createDeflateRaw,
	gunzipSync,
} from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { brotliStream, gzipStream, waitsForZlib } from "./compress.js";

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

/** `body` in chunks of `size` bytes. */
function split(body: Uint8Array, size: number): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < body.byteLength; offset += size) {
		chunks.push(body.subarray(offset, offset + size));
	}
	return chunks;
}

/** The window of a brotli stream, as the base-2 logarithm. RFC 7932, section 9.1, encodes 18 to 24 in the first 4 bits as `nnn1`, with `nnn` = bits − 17. */
function windowBits(output: Buffer): number {
	return 17 + Math.floor(((output[0] ?? 0) % 16) / 2);
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
	return (await import("./compress.js")).gzipStream;
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

describe("brotliStream", () => {
	it("sends brotli bytes that decode to the body, for an empty, a one-chunk, and a streamed body", async () => {
		const bodies = [[], [page], [page, encoder.encode("tail"), page]];

		const decoded = await Promise.all(
			bodies.map(async (chunks) =>
				brotliDecompressSync(await bytes(brotliStream(pulled(chunks)))).toString(),
			),
		);

		expect(decoded).toStrictEqual(
			bodies.map((chunks) => chunks.map((chunk) => Buffer.from(chunk).toString()).join("")),
		);
	});

	it("sends the same bytes for a page from a pooled encoder, whatever body it sent before", async () => {
		const before = await bytes(brotliStream(queued(page)));

		await bytes(brotliStream(queued(new Uint8Array(randomBytes(64 * 1024)))));
		const after = await bytes(brotliStream(queued(page)));

		expect(after.equals(before)).toBe(true);
		expect(brotliDecompressSync(after)).toStrictEqual(Buffer.from(page));
	});

	it("sends a 256 KiB window, for a one-chunk and a streamed body", async () => {
		const outputs = await Promise.all([
			bytes(brotliStream(queued(page))),
			bytes(brotliStream(pulled([page, page]))),
		]);

		expect(outputs.map((output) => windowBits(output))).toStrictEqual([18, 18]);
	});

	it("sends the bytes of one brotli call for a streamed body up to 256 KiB", async () => {
		const body = encoder.encode(
			Array.from({ length: 3000 }, (_, row) => `<tr><td>${row}</td><td>${row * 7}</td></tr>`).join(
				"",
			),
		);
		const params = {
			[constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
			[constants.BROTLI_PARAM_QUALITY]: 4,
			[constants.BROTLI_PARAM_LGWIN]: 18,
		};

		const output = await bytes(brotliStream(pulled(split(body, 16 * 1024))));

		expect(body.byteLength).toBeGreaterThan(64 * 1024);
		expect(output.equals(brotliCompressSync(body, { params }))).toBe(true);
	});

	it("sends a 4 MiB window for a streamed body over 256 KiB, so it finds a repeat 320 KiB back", async () => {
		const half = seededBytes(320 * 1024, 5);
		const body = Buffer.concat([half, half]);

		const output = await bytes(brotliStream(pulled(split(body, 64 * 1024))));

		expect(windowBits(output)).toBe(22);
		expect(output.byteLength).toBeLessThan(half.byteLength * 1.1);
		expect(brotliDecompressSync(output)).toStrictEqual(body);
	});

	it("sends the start of a body when the source waits for its next chunk", async () => {
		const shell = encoder.encode("<html><body><main>".repeat(100));
		const tail = encoder.encode("</main></body></html>");
		let release = () => {};
		const late = new Promise<void>((resolve) => {
			release = resolve;
		});
		let pulls = 0;
		const source = new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					pulls += 1;
					if (pulls === 1) {
						controller.enqueue(shell);
					} else if (pulls === 2) {
						await late;
						controller.enqueue(tail);
					} else {
						controller.close();
					}
				},
			},
			{ highWaterMark: 0 },
		);
		const reader = brotliStream(source).getReader();

		const first = await reader.read();
		release();
		const parts = [Buffer.from(first.value ?? [])];
		for (let next = await reader.read(); !next.done; next = await reader.read()) {
			parts.push(Buffer.from(next.value));
		}

		expect(first.done).toBe(false);
		expect(windowBits(parts[0] ?? Buffer.alloc(0))).toBe(18);
		expect(brotliDecompressSync(Buffer.concat(parts)).toString()).toBe(
			Buffer.concat([shell, tail]).toString(),
		);
	});

	it("keeps a tail that comes with the end during the first zlib write", async () => {
		const shell = Buffer.alloc(200 * 1024, 97);
		const tail = encoder.encode("</main></body></html>");
		let pulls = 0;
		const source = new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					pulls += 1;
					if (pulls === 1) {
						controller.enqueue(shell);
						return;
					}
					// Why two turns: the hold stops after one, and the zlib write is still open after two.
					await new Promise((resolve) => {
						setImmediate(resolve);
					});
					await new Promise((resolve) => {
						setImmediate(resolve);
					});
					controller.enqueue(tail);
					controller.close();
				},
			},
			{ highWaterMark: 0 },
		);

		const output = await bytes(brotliStream(source));

		expect(brotliDecompressSync(output)).toStrictEqual(Buffer.concat([shell, tail]));
	});

	it("sends the start of a body when the source gives empty chunks", async () => {
		const shell = encoder.encode("<html><body><main>".repeat(100));
		let pulls = 0;
		const source = new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					pulls += 1;
					if (pulls === 1) {
						controller.enqueue(shell);
					} else if (pulls <= 10_000) {
						controller.enqueue(new Uint8Array());
					} else {
						await new Promise(() => {});
					}
				},
			},
			{ highWaterMark: 0 },
		);
		const reader = brotliStream(source).getReader();

		const first = await reader.read();
		await reader.cancel();

		expect(first.done).toBe(false);
		expect(pulls).toBeLessThan(10);
	});

	it("holds at most 1,024 chunks of a body of tiny chunks", async () => {
		const body = Buffer.alloc(4096, 97);
		let pulls = 0;
		const source = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls += 1;
					if (pulls > body.byteLength) {
						controller.close();
					} else {
						controller.enqueue(body.subarray(pulls - 1, pulls));
					}
				},
			},
			{ highWaterMark: 0 },
		);
		const reader = brotliStream(source).getReader();

		const first = await reader.read();
		const pullsBeforeFirst = pulls;
		const parts = [Buffer.from(first.value ?? [])];
		for (let next = await reader.read(); !next.done; next = await reader.read()) {
			parts.push(Buffer.from(next.value));
		}

		expect(pullsBeforeFirst).toBeLessThanOrEqual(1025);
		expect(brotliDecompressSync(Buffer.concat(parts))).toStrictEqual(body);
	});

	it("starts no encoder when the consumer cancels during the hold", async () => {
		const errors: unknown[] = [];
		const onError = (error: unknown) => {
			errors.push(error);
		};
		process.on("uncaughtException", onError);
		let cancel = () => {};
		let pulls = 0;
		const stream = brotliStream(
			new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						pulls += 1;
						controller.enqueue(new Uint8Array(pulls === 1 ? 1024 : 0));
						if (pulls === 2) {
							queueMicrotask(() => {
								cancel();
							});
						}
					},
				},
				{ highWaterMark: 0 },
			),
		);
		const reader = stream.getReader();
		cancel = () => {
			void reader.cancel();
		};

		const result = await reader.read();
		// Why wait for `busy`: an encoder that started clears it only when it ends.
		await vi.waitFor(() => {
			expect(waitsForZlib(stream)).toBe(false);
		});
		process.off("uncaughtException", onError);

		expect(result.done).toBe(true);
		expect(errors).toStrictEqual([]);
	});

	it("copies at most 256 KiB to hold a body that ends with a large chunk", async () => {
		const body = seededBytes(512 * 1024, 7);
		const concat = vi.spyOn(Buffer, "concat");

		const output = await bytes(brotliStream(pulled([body.subarray(0, 1024), body.subarray(1024)])));
		const copied = concat.mock.calls.map(([list]) =>
			list.reduce((sum, each) => sum + each.byteLength, 0),
		);
		concat.mockRestore();

		expect(Math.max(0, ...copied)).toBeLessThanOrEqual(256 * 1024);
		expect(brotliDecompressSync(output).equals(body)).toBe(true);
	});
});
