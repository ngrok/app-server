import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../core/create-server.js";
import { createEntry } from "../core/entry.js";
import { requestContext } from "../core/request-context.js";
import { stubFramework } from "../test-server.js";
import { handler, host } from "./index.js";

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
	await close?.();
	close = undefined;
});

/** Serves `handler` for an app on `node:http`, as a Vercel Function does, and gives its URL. */
async function serve(): Promise<string> {
	const app = createServer({ plugins: [] });
	app.get("/whoami", (context) =>
		context.json({ url: context.req.url, client: requestContext()?.clientAddress }),
	);
	const entry = createEntry({
		app,
		host,
		clientDirectory: "/nonexistent",
		framework: () => stubFramework(),
	});
	const listener = handler(entry);
	const server = createHttpServer((incoming, outgoing) => {
		void listener(incoming, outgoing);
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	close = async () =>
		new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("handler", () => {
	it("takes the scheme and the client address from the headers that Vercel sets", async () => {
		const base = await serve();

		const response = await fetch(`${base}/whoami?q=1`, {
			headers: { "X-Forwarded-Proto": "https", "X-Real-IP": "203.0.113.7" },
		});

		await expect(response.json()).resolves.toStrictEqual({
			url: `${base.replace(/^http:/u, "https:")}/whoami?q=1`,
			client: "203.0.113.7",
		});
	});

	it("renders with the framework when no route answers", async () => {
		const base = await serve();

		const response = await fetch(`${base}/about`);

		await expect(response.text()).resolves.toBe("rendered");
	});
});
