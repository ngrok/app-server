import { createServer, get } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SentBody } from "../core/types.js";
import { countSent } from "./count-sent.js";

/** Serves `respond` on `node:http` with `countSent` around each response, and gives its URL. */
async function serve(
	respond: (outgoing: ServerResponse) => void,
	report: (sent: SentBody) => void,
): Promise<string> {
	const server = createServer((_incoming, outgoing) => {
		countSent({ outgoing }, report);
		respond(outgoing);
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	onTestFinished(async () => {
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
	});
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

describe("countSent", () => {
	it("counts each chunk that write and end send, in the bytes of its encoding", async () => {
		const report = vi.fn<(sent: SentBody) => void>();
		const url = await serve((outgoing) => {
			outgoing.write("héllo", "utf8");
			outgoing.write("6869", "hex");
			outgoing.end(Buffer.from("!"));
		}, report);

		const body = await (await fetch(url)).text();
		await vi.waitFor(() => {
			expect(report).toHaveBeenCalledTimes(1);
		});

		expect(body).toBe("héllohi!");
		expect(report).toHaveBeenCalledWith({ bytes: 9, aborted: false });
	});

	it("keeps the response going when report throws", async () => {
		const report = vi.fn<(sent: SentBody) => void>(() => {
			throw new Error("the sink is closed");
		});
		const url = await serve((outgoing) => {
			outgoing.end("ok");
		}, report);

		await expect((await fetch(url)).text()).resolves.toBe("ok");
		await vi.waitFor(() => {
			expect(report).toHaveBeenCalledTimes(1);
		});
		await expect((await fetch(url)).text()).resolves.toBe("ok");
	});

	it("gives false for a request with no Node response", () => {
		expect(countSent({}, () => {})).toBe(false);
	});

	it("reports at once for a response whose client already left", async () => {
		const report = vi.fn<(sent: SentBody) => void>();
		const left = Promise.withResolvers<undefined>();
		const server = createServer((incoming, outgoing) => {
			incoming.socket.destroy();
			outgoing.once("close", () => {
				countSent({ outgoing }, report);
				left.resolve(undefined);
			});
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		onTestFinished(async () => {
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		});

		get(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`).once("error", () => {});
		await left.promise;

		expect(report).toHaveBeenCalledWith({ bytes: 0, aborted: true });
	});
});
