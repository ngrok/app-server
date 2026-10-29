import { afterEach, describe, expect, it, vi } from "vitest";
import { eventStream } from "./event-stream.js";

afterEach(() => {
	vi.useRealTimers();
});

async function readAll(response: Response): Promise<string> {
	return new TextDecoder().decode(await response.arrayBuffer());
}

describe("eventStream", () => {
	it("writes each event in the event-stream format and ends when produce resolves", async () => {
		const response = eventStream({}, ({ send }) => {
			send({ event: "update", id: "7", data: "line one\nline two" });
		});

		expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
		expect(await readAll(response)).toBe(
			"event: update\nid: 7\ndata: line one\ndata: line two\n\n",
		);
	});

	it("splits the data on a lone carriage return, so the client cannot read it as a field", async () => {
		const response = eventStream({}, ({ send }) => {
			send({ data: "first\revent: injected" });
		});

		expect(await readAll(response)).toBe("data: first\ndata: event: injected\n\n");
	});

	it("refuses a line break in the event name", async () => {
		const response = eventStream({}, ({ send }) => {
			send({ event: "update\ndata: injected", data: "x" });
		});

		await expect(readAll(response)).rejects.toThrow("cannot contain a line break");
	});

	it("sends a heartbeat comment while the stream is quiet", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const response = eventStream({ heartbeatMs: 1_000 }, () => new Promise(() => {}));
		const reader = response.body?.getReader();

		await vi.advanceTimersByTimeAsync(1_000);
		const chunk = await reader?.read();
		await reader?.cancel();

		expect(new TextDecoder().decode(chunk?.value)).toBe(": ping\n\n");
	});

	it("aborts the producer's signal and ends the stream when the request aborts", async () => {
		const request = new AbortController();
		let producerSignal: AbortSignal | undefined;
		const response = eventStream({ signal: request.signal }, ({ signal }) => {
			producerSignal = signal;
			return new Promise(() => {});
		});

		request.abort();

		expect(await readAll(response)).toBe("");
		expect(producerSignal?.aborted).toBe(true);
	});

	it("errors the stream when produce rejects", async () => {
		const response = eventStream({}, () => Promise.reject(new Error("upstream failed")));

		await expect(readAll(response)).rejects.toThrow("upstream failed");
	});
});
