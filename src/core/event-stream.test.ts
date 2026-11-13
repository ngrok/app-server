import { getEventListeners } from "node:events";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { eventStream } from "./event-stream.js";
import { abortShutdownSignal, renewShutdownSignal, shutdownSignal } from "./shutdown.js";

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

	it("refuses a line break in the event name", async () => {
		const response = eventStream({}, ({ send }) => {
			send({ event: "update\ndata: injected", data: "x" });
		});

		await expect(readAll(response)).rejects.toThrow("cannot contain a line break");
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
	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
		"refuses a heartbeatMs of %s with a message that names it",
		(heartbeatMs) => {
			expect(() => eventStream({ heartbeatMs }, () => {})).toThrow(
				new RangeError(
					`eventStream needs a heartbeatMs that is an integer from 1 to 2147483647, not ${heartbeatMs}.`,
				),
			);
		},
	);

	it.each([1, 2_147_483_647])("takes a heartbeatMs of %s", async (heartbeatMs) => {
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
		produce: () => Promise<void>;
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
				const response = eventStream({ signal: request.signal }, async ({ signal }) => {
					signal.addEventListener("abort", onAbort);
					return produce();
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
