import { getEventListeners, once } from "node:events";
import { connect } from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { defaultPlugins } from "./create-server.js";
import { eventStream } from "./event-stream.js";
import type { EventStreamSink } from "./event-stream.js";
import { abortShutdownSignal, renewShutdownSignal, shutdownSignal } from "./shutdown.js";
import { tcp } from "../node/tcp.js";
import { testServer } from "../test-server.js";

afterEach(() => {
	vi.useRealTimers();
});

async function readAll(response: Response): Promise<string> {
	return new TextDecoder().decode(await response.arrayBuffer());
}

/** Runs a full garbage collection. Why this way: Vitest starts no worker with `--expose-gc`. */
function collectGarbage(): void {
	setFlagsFromString("--expose-gc");
	const collect = runInNewContext("gc") as () => void;
	collect();
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

	it("errors the stream when produce rejects", async () => {
		const response = eventStream({}, async () => {
			throw new Error("upstream failed");
		});

		await expect(readAll(response)).rejects.toThrow("upstream failed");
	});

	it("keeps 1 MiB of events for a client that does not read, and fails the stream for more", async () => {
		const produced = Promise.withResolvers<undefined>();
		let producerSignal: AbortSignal | undefined;
		let abortedAtLimit: boolean | undefined;
		const response = eventStream({}, ({ send, signal }) => {
			producerSignal = signal;
			// Why 8 less: `data: ` and the two line ends add 8 bytes, so this event is 1 MiB.
			send({ data: "x".repeat(1024 * 1024 - 8) });
			abortedAtLimit = signal.aborted;
			send({ data: "" });
			produced.resolve(undefined);
		});
		await produced.promise;

		const failure: unknown = await readAll(response).catch((error: unknown) => error);

		expect(abortedAtLimit).toBe(false);
		expect(failure).toStrictEqual(
			new Error("The event stream stopped: more than 1 MiB of events waited for the client."),
		);
		expect(producerSignal?.reason).toBe(failure);
	});

	it("closes the connection of a client that stops reading", async () => {
		const reason = Promise.withResolvers<unknown>();
		const { internals, framework } = await testServer({
			plugins: defaultPlugins(),
			render: async (request) =>
				eventStream({ signal: request.signal }, async ({ send, signal }) => {
					signal.addEventListener("abort", () => {
						reason.resolve(signal.reason);
					});
					const data = "x".repeat(64 * 1024);
					while (!signal.aborted) {
						send({ data });
						// Why a turn of the event loop: the listener writes each event to the socket.
						await new Promise((resolve) => {
							setImmediate(resolve);
						});
					}
				}),
			options: { listeners: [tcp({ port: 0, host: "127.0.0.1" })] },
		});
		const server = await internals.listen(framework, []);
		onTestFinished(async () => {
			await server.shutdown();
			renewShutdownSignal();
		});
		const socket = connect(Number(new URL(server.urls[0] ?? "").port), "127.0.0.1");
		socket.on("error", () => {});

		// The client sends its request, and reads nothing.
		socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");

		await expect(reason.promise).resolves.toStrictEqual(
			new Error("The event stream stopped: more than 1 MiB of events waited for the client."),
		);
		// Why read now: a socket that does not read does not see that the server closed it.
		const received: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => {
			received.push(chunk);
		});
		await once(socket, "close");
		// Why: the last chunk of a complete response is `0`, and a cut response must not have it.
		expect(Buffer.concat(received).subarray(-5).toString()).not.toBe("0\r\n\r\n");
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
		{
			end: "the client does not read",
			produce: async ({ send }) => {
				// Why two events: the client can take the first one before it waits.
				send({ data: "x".repeat(1024 * 1024) });
				send({ data: "x".repeat(1024 * 1024) });
				return new Promise(() => {});
			},
			finish: async (response) => readAll(response).catch(() => {}),
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
			await new Promise((resolve) => {
				setImmediate(resolve);
			});

			collectGarbage();

			expect(listener.deref()).toBeUndefined();
		},
	);
});
