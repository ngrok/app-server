import { describe, expect, it } from "vitest";
import { copyPath, readIfQueued } from "./compression.js";
import type { ReadResult } from "./compression.js";

describe("copyPath", () => {
	it("names the copy as a dotfile next to its file", () => {
		expect(copyPath("/assets/app-abc123.js", "br")).toBe("/assets/.app-abc123.js.br");
		expect(copyPath("/docs/button/index.html", "gzip")).toBe("/docs/button/.index.html.gz");
		expect(copyPath("/llms.txt", "gzip")).toBe("/.llms.txt.gz");
	});

	it("changes only the name of the file, also in a dot directory or for a name with a dot first", () => {
		expect(copyPath("/.well-known/security.txt", "br")).toBe("/.well-known/.security.txt.br");
		expect(copyPath("/v1.2/.hidden", "br")).toBe("/v1.2/..hidden.br");
	});
});

describe("readIfQueued", () => {
	const chunk: ReadResult = { done: false, value: new Uint8Array(1) };

	/** A reader whose read settles after `turns` turns of the microtask queue: with `chunk`, or with `failure`. */
	function readerAfter(turns: number, failure?: Error): ReadableStreamDefaultReader<Uint8Array> {
		const settle = (): ReadResult => {
			if (failure != null) {
				throw failure;
			}
			return chunk;
		};
		// oxlint-disable-next-line typescript/promise-function-async -- an async function adds turns to the read.
		const read = (): Promise<ReadResult> => {
			if (turns === 0) {
				return failure == null ? Promise.resolve(chunk) : Promise.reject(failure);
			}
			// Why a chain of `then`: each one takes one turn.
			let turn = Promise.resolve();
			for (let index = 1; index < turns; index += 1) {
				turn = turn.then(() => undefined);
			}
			return turn.then(settle);
		};
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the function calls only `read`.
		return { read } as ReadableStreamDefaultReader<Uint8Array>;
	}

	/** The answer for `reader`, and the count of turns of the microtask queue until the caller has it. */
	async function answerOf(reader: ReadableStreamDefaultReader<Uint8Array>) {
		let turns = 0;
		// Why 20: each answer comes within 20 turns.
		const counter = (async () => {
			for (let turn = 0; turn < 20; turn += 1) {
				turns += 1;
				await Promise.resolve();
			}
		})();
		let kind = "throws";
		try {
			const next = await readIfQueued(reader);
			kind = "pending" in next ? "pending" : "result";
			if ("pending" in next) {
				// Why: the read of some readers fails later, and the test must not leave it with no handler.
				next.pending.catch(() => {});
			}
		} catch {
			// The read failed within the wait.
		}
		const at = turns;
		await counter;
		return { kind, at };
	}

	it("gives a read that settles within three turns as a result, and a later read as still open", async () => {
		const kinds: string[] = [];
		for (let turns = 0; turns <= 6; turns += 1) {
			kinds.push((await answerOf(readerAfter(turns))).kind);
		}

		expect(kinds).toStrictEqual([
			"result",
			"result",
			"result",
			"result",
			"pending",
			"pending",
			"pending",
		]);
	});

	it("throws for a read that fails within three turns, and gives a later failure with the open read", async () => {
		const failure = new Error("the client left");
		const kinds: string[] = [];
		for (let turns = 0; turns <= 5; turns += 1) {
			kinds.push((await answerOf(readerAfter(turns, failure))).kind);
		}
		const late = await readIfQueued(readerAfter(5, failure));

		expect(kinds).toStrictEqual(["throws", "throws", "throws", "throws", "pending", "pending"]);
		await expect("pending" in late ? late.pending : undefined).rejects.toBe(failure);
	});

	it("answers one turn later for each turn that the read takes, and each open read at one turn", async () => {
		const at: number[] = [];
		for (let turns = 0; turns <= 6; turns += 1) {
			at.push((await answerOf(readerAfter(turns))).at);
		}
		const [first = 0] = at;

		expect(at.map((turn) => turn - first)).toStrictEqual([0, 1, 2, 3, 3, 3, 3]);
	});

	it("gives the read of a stream that calls it in its pull as still open", async () => {
		const source = new Response("hello").body?.getReader();
		const stream = new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					const next = source == null ? undefined : await readIfQueued(source);
					if (next != null && "result" in next && !next.result.done) {
						controller.enqueue(next.result.value);
					}
				},
			},
			{ highWaterMark: 0 },
		);

		const next = await readIfQueued(stream.getReader());
		const read = "pending" in next ? await next.pending : undefined;

		expect(new TextDecoder().decode(read?.value)).toBe("hello");
	});

	it("reads the chunk and the end of a body from a string, and never waits for a source", async () => {
		const body = new Response("hello").body?.getReader();
		const waiting = new ReadableStream<Uint8Array>({ pull: async () => new Promise(() => {}) });
		if (body == null) {
			throw new Error("The response has no body.");
		}

		const first = await readIfQueued(body);
		const end = await readIfQueued(body);
		const open = await readIfQueued(waiting.getReader());

		expect("result" in first && !first.result.done).toBe(true);
		expect("result" in end && end.result.done).toBe(true);
		expect("pending" in open).toBe(true);
	});
});
