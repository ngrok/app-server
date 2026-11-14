import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPlugins } from "./create-server.js";
import { eventStream } from "./event-stream.js";
import type { EventStreamSink } from "./event-stream.js";
import { abortShutdownSignal, createShutdownState, shutdownSignal } from "./shutdown.js";
import { collectGarbage, testServer } from "../test-server.js";

// Why: outside a request, `shutdownSignal()` is the signal of the last `createServer` call, and a
// test that stops a server leaves that signal aborted.
beforeEach(() => {
	createShutdownState();
});

afterEach(() => {
	vi.useRealTimers();
});

async function readAll(response: Response): Promise<string> {
	return new TextDecoder().decode(await response.arrayBuffer());
}

/**
 * A stream whose producer never ends, with its sink and a reader of its body, so the test sends
 * each event.
 */
async function openStream(): Promise<
	EventStreamSink & { reader: ReadableStreamDefaultReader<Uint8Array> }
> {
	const sink = Promise.withResolvers<EventStreamSink>();
	const response = eventStream(async (given) => {
		sink.resolve(given);
		return new Promise(() => {});
	});
	if (response.body == null) {
		throw new Error("The event stream has no body.");
	}
	return { ...(await sink.promise), reader: response.body.getReader() };
}

/** Resolves in the next turn of the event loop. */
async function nextTurn(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

describe("eventStream", () => {
	it("writes each event in the event-stream format and ends when produce resolves", async () => {
		const response = eventStream(({ send }) => {
			void send({ event: "update", id: "7", data: "line one\nline two" });
		});

		expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
		await expect(readAll(response)).resolves.toBe(
			"event: update\nid: 7\ndata: line one\ndata: line two\n\n",
		);
	});

	it("sends Cache-Control: no-cache, and a Cache-Control of the headers option in its place", async () => {
		const byDefault = eventStream(() => {}, { headers: { "X-Feed": "orders" } });
		const withOption = eventStream(() => {}, {
			headers: { "cache-control": "no-cache, no-transform" },
		});

		expect(Object.fromEntries(byDefault.headers)).toStrictEqual({
			"cache-control": "no-cache",
			"content-type": "text/event-stream; charset=utf-8",
			"x-feed": "orders",
		});
		expect(withOption.headers.get("Cache-Control")).toBe("no-cache, no-transform");
	});

	// Why: a compressed stream holds an encoder for its whole life, and a quiet feed saves few bytes.
	it("goes out with no compression when the headers option has no-transform", async () => {
		const { request } = await testServer({
			plugins: defaultPlugins(),
			render: async (given) =>
				eventStream(
					// Why it stays open: the server sends a short body that ends at once with no compression.
					async ({ send }) => {
						void send({ data: "hello" });
						return new Promise(() => {});
					},
					given.url.endsWith("/plain")
						? { headers: { "Cache-Control": "no-cache, no-transform" } }
						: {},
				),
		});
		const headers = { "Accept-Encoding": "br" };

		const compressed = await request("/feed", { headers });
		const plain = await request("/plain", { headers });
		const reader = plain.body?.getReader();
		const first = await reader?.read();
		await reader?.cancel();

		expect(compressed.headers.get("Content-Encoding")).toBe("br");
		expect(plain.headers.get("Content-Encoding")).toBeNull();
		expect(new TextDecoder().decode(first?.value)).toBe("data: hello\n\n");
	});

	it("splits the data on a lone carriage return, so the client cannot read it as a field", async () => {
		const response = eventStream(({ send }) => {
			void send({ data: "first\revent: injected" });
		});

		await expect(readAll(response)).resolves.toBe("data: first\ndata: event: injected\n\n");
	});

	it("writes each line of the data as one line, for each kind of line break", async () => {
		const response = eventStream(({ send }) => {
			void send({ data: "one\r\ntwo\rthree\nfour\n" });
			void send({ id: "8", data: "" });
		});

		await expect(readAll(response)).resolves.toBe(
			"data: one\ndata: two\ndata: three\ndata: four\ndata: \n\nid: 8\ndata: \n\n",
		);
	});

	it.each([
		{ field: "event", event: { event: "update\ndata: injected", data: "x" } },
		{ field: "id", event: { id: "7\rdata: injected", data: "x" } },
	])("refuses a line break in the $field of an event", async ({ event }) => {
		const response = eventStream(({ send }) => {
			void send(event);
		});

		await expect(readAll(response)).rejects.toThrow(
			new TypeError("An event's `event` and `id` cannot contain a line break."),
		);
	});

	// Why: a value can have another type than its type says, such as the result of
	// `JSON.stringify(undefined)` or a field of a parsed request body. An array would send its line
	// breaks as they are, so a client would read them as fields.
	it.each([
		{ value: "undefined", data: undefined, type: "undefined" },
		{ value: "null", data: null, type: "object" },
		{ value: "a number", data: 42, type: "number" },
		{ value: "an array with a line break", data: ["x\nevent: injected"], type: "object" },
		{ value: "a typed array", data: new Uint8Array([97, 10, 98]), type: "object" },
	])("refuses data that is $value", async ({ data, type }) => {
		const response = eventStream(({ send }) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test sends a value that its type does not allow.
			void send({ data: data as unknown as string });
		});

		await expect(readAll(response)).rejects.toThrow(
			new TypeError(`An event's \`data\` must be a string, not ${type}.`),
		);
	});

	it("sends a heartbeat comment while the stream is quiet", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const response = eventStream(async () => new Promise(() => {}), { heartbeatMs: 1_000 });
		const reader = response.body?.getReader();

		await vi.advanceTimersByTimeAsync(1_000);
		const chunk = await reader?.read();
		await reader?.cancel();

		expect(new TextDecoder().decode(chunk?.value)).toBe(": ping\n\n");
	});

	// Why: a timer turns a delay that it cannot hold into 1 ms, so the stream would send a ping each millisecond.
	it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
		"refuses a heartbeatMs of %s with a message that names it",
		(heartbeatMs) => {
			expect(() => eventStream(() => {}, { heartbeatMs })).toThrow(
				new RangeError(`eventStream needs a heartbeatMs from 1 to 2147483647, not ${heartbeatMs}.`),
			);
		},
	);

	// Why 1.5: a timer holds a delay with a fraction, such as the result of `seconds * 1000`.
	it.each([1, 1.5, 2_147_483_647])("takes a heartbeatMs of %s", async (heartbeatMs) => {
		const response = eventStream(
			({ send }) => {
				void send({ data: "x" });
			},
			{ heartbeatMs },
		);

		await expect(readAll(response)).resolves.toBe("data: x\n\n");
	});

	it("aborts the producer's signal and ends the stream when the request aborts", async () => {
		const request = new AbortController();
		let producerSignal: AbortSignal | undefined;
		const response = eventStream(
			async ({ signal }) => {
				producerSignal = signal;
				return new Promise(() => {});
			},
			{ signal: request.signal },
		);

		request.abort("the client left");

		await expect(readAll(response)).resolves.toBe("");
		expect(producerSignal?.aborted).toBe(true);
		expect(producerSignal?.reason).toBe("the client left");
	});

	// Why: a request can arrive after the shutdown signal aborted, and the drain must not wait for it.
	it.each<{ source: string; start: (produce: () => void) => Response }>([
		{
			source: "the request aborted",
			start: (produce) => eventStream(produce, { signal: AbortSignal.abort() }),
		},
		{
			source: "the server shut down",
			start: (produce) => {
				abortShutdownSignal();
				return eventStream(produce);
			},
		},
	])("ends at once and does not run produce when $source before the call", async ({ start }) => {
		const produce = vi.fn<() => void>();

		const response = start(produce);

		await expect(readAll(response)).resolves.toBe("");
		// Why a turn of the event loop: `produce` starts in a microtask.
		await nextTurn();
		expect(produce).not.toHaveBeenCalled();
	});

	// Why: the server cancels the body of a HEAD response, and the listener the body of a closed socket.
	it("aborts the producer's signal when the client cancels the body", async () => {
		const { signal, reader } = await openStream();

		await reader.cancel();

		expect(signal.aborted).toBe(true);
	});

	it("errors the stream when produce rejects", async () => {
		const response = eventStream(async () => {
			throw new Error("upstream failed");
		});

		await expect(readAll(response)).rejects.toThrow("upstream failed");
	});

	it("ignores an event that the producer sends after the stream ended", async () => {
		const { send, reader } = await openStream();
		await reader.cancel();

		await expect(send({ data: "late" })).resolves.toBeUndefined();
	});

	it("sends each event of a burst of more than 1 MiB to a client that reads, when the producer awaits send", async () => {
		const clientRead = Promise.withResolvers<undefined>();
		const response = eventStream(async ({ send }) => {
			await send({ data: "" });
			await clientRead.promise;
			for (let count = 0; count < 1_100; count += 1) {
				await send({ data: "x".repeat(1024 - 8) });
			}
		});
		const reader = response.body?.getReader();
		await reader?.read();
		clientRead.resolve(undefined);
		let bytes = 0;

		for (let chunk = await reader?.read(); chunk?.done === false; chunk = await reader?.read()) {
			bytes += chunk.value.byteLength;
		}

		expect(bytes).toBe(1_100 * 1024);
	});

	it("makes send wait while the client has 64 KiB unread, until the client reads", async () => {
		const { send, reader } = await openStream();
		const data = "x".repeat(32 * 1024);

		await expect(send({ data })).resolves.toBeUndefined();
		const full = send({ data });
		const before = await Promise.race([
			full.then(() => "resolved"),
			nextTurn().then(() => "waiting"),
		]);
		await reader.read();

		await expect(full).resolves.toBeUndefined();
		expect(before).toBe("waiting");
		await reader.cancel();
	});

	it("stops a stream with more than 1 MiB unread, and aborts the signal of the producer", async () => {
		const { send, signal, reader } = await openStream();

		for (let count = 0; count < 17; count += 1) {
			void send({ data: "x".repeat(64 * 1024) });
		}

		expect(signal.aborted).toBe(true);
		expect(String(signal.reason)).toContain("Await send()");
		// Why drain first: the reader gives each queued chunk before it gives the error.
		const drained = async (): Promise<unknown> => {
			for (;;) {
				// oxlint-disable-next-line no-await-in-loop -- each read depends on the one before it.
				const chunk = await reader.read();
				if (chunk.done) {
					return undefined;
				}
			}
		};
		await expect(drained()).rejects.toThrow("Await send()");
	});

	it("sends 4 MiB through gzip to a client that reads, when the producer awaits send", async () => {
		const data = Buffer.from(crypto.getRandomValues(new Uint8Array(48 * 1024))).toString("base64");
		const { request } = await testServer({
			plugins: defaultPlugins(),
			render: async () =>
				eventStream(async ({ send }) => {
					for (let count = 0; count < 64; count += 1) {
						await send({ data });
					}
				}),
		});

		const response = await request("/feed", { headers: { "Accept-Encoding": "gzip" } });
		const body = await new Response(
			response.body?.pipeThrough(new DecompressionStream("gzip")),
		).text();

		expect(response.headers.get("Content-Encoding")).toBe("gzip");
		expect(body).toBe(`data: ${data}\n\n`.repeat(64));
	});

	it("resolves a send that waits when the client leaves", async () => {
		const { send, reader } = await openStream();
		const waiting = send({ data: "x".repeat(64 * 1024) });

		await reader.cancel();

		await expect(waiting).resolves.toBeUndefined();
	});

	it("sends each event at once to a client that reads, also past 1 MiB in total", async () => {
		const data = "x".repeat(256 * 1024);
		let sendNext = () => {};
		const clientRead = async () =>
			new Promise<void>((resolve) => {
				sendNext = resolve;
			});
		const response = eventStream(async ({ send }) => {
			for (let count = 0; count < 8; count += 1) {
				void send({ data });
				await clientRead();
			}
		});
		const reader = response.body?.getReader();
		const sizes: number[] = [];

		for (let chunk = await reader?.read(); chunk?.done === false; chunk = await reader?.read()) {
			sizes.push(chunk.value.byteLength);
			sendNext();
		}

		expect(sizes).toStrictEqual(Array.from({ length: 8 }, () => data.length + 8));
	});

	// Why: Node.js keeps a signal that follows `shutdownSignal()`, with each listener that the producer
	// left on it, until the server stops.
	it.each<{ source: string; abort: (request: AbortController) => void }>([
		{
			source: "the request aborts",
			abort: (request) => {
				request.abort();
			},
		},
		{ source: "the server shuts down", abort: abortShutdownSignal },
	])(
		"does not abort the signal of a stream that ended by itself when $source later",
		async ({ abort }) => {
			const request = new AbortController();
			const onAbort = vi.fn<() => void>();
			let producerSignal: AbortSignal | undefined;
			const response = eventStream(
				({ signal }) => {
					producerSignal = signal;
					signal.addEventListener("abort", onAbort);
				},
				{ signal: request.signal },
			);
			await readAll(response);

			abort(request);

			expect(producerSignal?.aborted).toBe(false);
			expect(onAbort).not.toHaveBeenCalled();
		},
	);

	// Why: a signal walks its list of listeners to add or remove one, so a listener for each open
	// stream makes each stream cost more as more streams are open.
	it("adds no listener to shutdownSignal() for an open stream", async () => {
		const response = eventStream(async () => new Promise(() => {}));

		expect(getEventListeners(shutdownSignal(), "abort")).toStrictEqual([]);
		await response.body?.cancel();
	});

	// Why: a listener that outlives its stream keeps all that it holds, and `shutdownSignal()` lives
	// until the server stops.
	it.each<{
		end: string;
		produce: (sink: EventStreamSink) => Promise<void>;
		finish: (response: Response) => Promise<unknown>;
	}>([
		{ end: "produce resolves", produce: async () => {}, finish: readAll },
		{
			end: "produce rejects",
			produce: async () => {
				throw new Error("upstream failed");
			},
			finish: async (response) => readAll(response).catch(() => {}),
		},
		{
			end: "the client leaves",
			produce: async () => new Promise(() => {}),
			finish: async (response) => response.body?.cancel(),
		},
	])(
		"frees a listener that the producer left on the signal, after $end",
		async ({ produce, finish }) => {
			const request = new AbortController();
			const streamed = async () => {
				const onAbort = () => {};
				const response = eventStream(
					async (sink) => {
						sink.signal.addEventListener("abort", onAbort);
						return produce(sink);
					},
					{ signal: request.signal },
				);
				await finish(response);
				return new WeakRef(onAbort);
			};
			const listener = await streamed();
			// Why a turn of the event loop: a `WeakRef` keeps its target until the turn that made it ends.
			await nextTurn();

			collectGarbage();

			expect(listener.deref()).toBeUndefined();
		},
	);
});
