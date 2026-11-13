import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { eventStream } from "./event-stream.js";
import type { EventStreamSink } from "./event-stream.js";
import { abortShutdownSignal, renewShutdownSignal, shutdownSignal } from "./shutdown.js";
import { collectGarbage } from "../test-server.js";

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
	const response = eventStream({}, async (given) => {
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
		const response = eventStream({}, ({ send }) => {
			send({ event: "update", id: "7", data: "line one\nline two" });
		});

		expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
		await expect(readAll(response)).resolves.toBe(
			"event: update\nid: 7\ndata: line one\ndata: line two\n\n",
		);
	});

	it("sends Cache-Control: no-cache, and a Cache-Control of the headers option in its place", async () => {
		const byDefault = eventStream({ headers: { "X-Feed": "orders" } }, () => {});
		const withOption = eventStream(
			{ headers: { "cache-control": "no-cache, no-transform" } },
			() => {},
		);

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
					given.url.endsWith("/plain")
						? { headers: { "Cache-Control": "no-cache, no-transform" } }
						: {},
					// Why it stays open: the server sends a short body that ends at once with no compression.
					async ({ send }) => {
						send({ data: "hello" });
						return new Promise(() => {});
					},
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
		const response = eventStream({}, ({ send }) => {
			send({ data: "first\revent: injected" });
		});

		await expect(readAll(response)).resolves.toBe("data: first\ndata: event: injected\n\n");
	});

	it("writes each line of the data as one line, for each kind of line break", async () => {
		const response = eventStream({}, ({ send }) => {
			send({ data: "one\r\ntwo\rthree\nfour\n" });
			send({ id: "8", data: "" });
		});

		await expect(readAll(response)).resolves.toBe(
			"data: one\ndata: two\ndata: three\ndata: four\ndata: \n\nid: 8\ndata: \n\n",
		);
	});

	it.each([
		{ field: "event", event: { event: "update\ndata: injected", data: "x" } },
		{ field: "id", event: { id: "7\rdata: injected", data: "x" } },
	])("refuses a line break in the $field of an event", async ({ event }) => {
		const response = eventStream({}, ({ send }) => {
			send(event);
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
		const response = eventStream({}, ({ send }) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test sends a value that its type does not allow.
			send({ data: data as unknown as string });
		});

		await expect(readAll(response)).rejects.toThrow(
			new TypeError(`An event's \`data\` must be a string, not ${type}.`),
		);
	});

	it("sends a heartbeat comment while the stream is quiet", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const response = eventStream({ heartbeatMs: 1_000 }, async () => new Promise(() => {}));
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
			expect(() => eventStream({ heartbeatMs }, () => {})).toThrow(
				new RangeError(`eventStream needs a heartbeatMs from 1 to 2147483647, not ${heartbeatMs}.`),
			);
		},
	);

	// Why 1.5: a timer holds a delay with a fraction, such as the result of `seconds * 1000`.
	it.each([1, 1.5, 2_147_483_647])("takes a heartbeatMs of %s", async (heartbeatMs) => {
		const response = eventStream({ heartbeatMs }, ({ send }) => {
			send({ data: "x" });
		});

		await expect(readAll(response)).resolves.toBe("data: x\n\n");
	});

	it("aborts the producer's signal and ends the stream when the request aborts", async () => {
		const request = new AbortController();
		let producerSignal: AbortSignal | undefined;
		const response = eventStream({ signal: request.signal }, async ({ signal }) => {
			producerSignal = signal;
			return new Promise(() => {});
		});

		request.abort("the client left");

		await expect(readAll(response)).resolves.toBe("");
		expect(producerSignal?.aborted).toBe(true);
		expect(producerSignal?.reason).toBe("the client left");
	});

	// Why: a request can arrive after the shutdown signal aborted, and the drain must not wait for it.
	it.each<{ source: string; start: (produce: () => void) => Response }>([
		{
			source: "the request aborted",
			start: (produce) => eventStream({ signal: AbortSignal.abort() }, produce),
		},
		{
			source: "the server shut down",
			start: (produce) => {
				abortShutdownSignal();
				return eventStream({}, produce);
			},
		},
	])("ends at once and does not run produce when $source before the call", async ({ start }) => {
		onTestFinished(renewShutdownSignal);
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
		const response = eventStream({}, async () => {
			throw new Error("upstream failed");
		});

		await expect(readAll(response)).rejects.toThrow("upstream failed");
	});

	it("sends each event of a burst of more than 1 MiB to a client that reads", async () => {
		const clientRead = Promise.withResolvers<undefined>();
		const response = eventStream({}, async ({ send }) => {
			send({ data: "" });
			await clientRead.promise;
			for (let count = 0; count < 1_100; count += 1) {
				send({ data: "x".repeat(1024 - 8) });
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

	it("sends each event at once to a client that reads, also past 1 MiB in total", async () => {
		const data = "x".repeat(256 * 1024);
		let sendNext = () => {};
		const clientRead = async () =>
			new Promise<void>((resolve) => {
				sendNext = resolve;
			});
		const response = eventStream({}, async ({ send }) => {
			for (let count = 0; count < 8; count += 1) {
				send({ data });
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
			onTestFinished(renewShutdownSignal);
			const request = new AbortController();
			const onAbort = vi.fn<() => void>();
			let producerSignal: AbortSignal | undefined;
			const response = eventStream({ signal: request.signal }, ({ signal }) => {
				producerSignal = signal;
				signal.addEventListener("abort", onAbort);
			});
			await readAll(response);

			abort(request);

			expect(producerSignal?.aborted).toBe(false);
			expect(onAbort).not.toHaveBeenCalled();
		},
	);

	// Why: a signal walks its list of listeners to add or remove one, so a listener for each open
	// stream makes each stream cost more as more streams are open.
	it("adds no listener to shutdownSignal() for an open stream", async () => {
		// Why: a new signal has no listener of another test.
		renewShutdownSignal();
		const response = eventStream({}, async () => new Promise(() => {}));

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
				const response = eventStream({ signal: request.signal }, async (sink) => {
					sink.signal.addEventListener("abort", onAbort);
					return produce(sink);
				});
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
