import { ServerResponse } from "node:http";
import type { ListenerBindings, SentBody } from "../core/types.js";

type WriteCallback = (error: Error | null | undefined) => void;

/** The bytes that Node sends for one chunk of a response body. */
function chunkBytes(chunk: unknown, encoding: unknown): number {
	if (typeof chunk === "string") {
		return Buffer.byteLength(
			chunk,
			typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8",
		);
	}
	return ArrayBuffer.isView(chunk) ? chunk.byteLength : 0;
}

/**
 * Counts the body bytes that the Node.js response of `bindings` sends from
 * now on, and calls `report` once when the response closes: after it ends,
 * or when the client goes away first. `report` can run before this returns.
 * It returns `false` when `bindings` has no Node.js response.
 *
 * `@hono/node-server` reads the first chunks of a body before it sends the
 * head. If the body fails then, it ends the response as complete, and the
 * report has `aborted: false`.
 *
 * Why patch `write` and `end`: Node.js keeps no count of the body bytes of
 * a response. Its `end` writes its chunk without a call to `write`, so no
 * chunk counts twice.
 *
 * @example
 * countSent(context.env, ({ bytes, aborted }) => logger.info("sent", { bytes, aborted }));
 */
export function countSent(bindings: ListenerBindings, report: (sent: SentBody) => void): boolean {
	const { outgoing } = bindings;
	if (!(outgoing instanceof ServerResponse)) {
		return false;
	}
	const send = (sent: SentBody) => {
		try {
			report(sent);
		} catch {
			// Why drop it: `report` runs in an event of Node's response, where a throw stops the process.
		}
	};
	// Why: a response whose client left during the render emits no `close` again.
	if (outgoing.destroyed) {
		send({ bytes: 0, aborted: true });
		return true;
	}
	let bytes = 0;
	const count = (chunk: unknown, encoding: unknown) => {
		// Why skip: Node drops a chunk after a destroy, such as the error text that `@hono/node-server` writes then.
		if (!outgoing.destroyed && !outgoing.writableEnded) {
			bytes += chunkBytes(chunk, encoding);
		}
	};
	const write = outgoing.write.bind(outgoing);
	const end = outgoing.end.bind(outgoing);
	outgoing.write = (
		chunk: unknown,
		encoding?: BufferEncoding | WriteCallback | null,
		callback?: WriteCallback,
	) => {
		count(chunk, encoding);
		return typeof encoding === "string"
			? write(chunk, encoding, callback)
			: write(chunk, encoding ?? callback);
	};
	outgoing.end = (
		chunk?: unknown,
		encoding?: BufferEncoding | (() => void),
		callback?: () => void,
	) => {
		if (typeof chunk !== "function") {
			count(chunk, encoding);
		}
		Reflect.apply(end, outgoing, [chunk, encoding, callback]);
		return outgoing;
	};
	outgoing.once("close", () => {
		send({ bytes, aborted: !outgoing.writableFinished });
	});
	return true;
}
