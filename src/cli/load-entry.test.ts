import { describe, expect, it, vi } from "vitest";
import { createServer } from "../core/create-server.js";
import { ENTRY_PROTOCOL } from "../core/entry-protocol.js";
import { createEntry } from "../core/entry.js";
import { requestContext } from "../core/request-context.js";
import { host } from "../node/index.js";
import { stubFramework } from "../test-server.js";
import { loadEntry } from "./load-entry.js";

describe("loadEntry", () => {
	it("runs the build's own entry, not one from this copy", async () => {
		const appServer = createEntry({
			app: createServer({ plugins: [] }),
			host,
			framework: () => stubFramework(),
		});

		await expect(loadEntry({ appServer })).resolves.toBe(appServer);
	});

	it("refuses an entry from another protocol version", async () => {
		const appServer = { protocol: ENTRY_PROTOCOL + 1 };

		await expect(loadEntry({ appServer })).rejects.toThrow(
			`does not use entry protocol ${ENTRY_PROTOCOL}`,
		);
	});

	it("makes one entry for a plain React Router build, on this copy", async () => {
		const build = { routes: {}, entry: {}, assetsBuildDirectory: "build/client" };

		const entry = await loadEntry(build);

		expect(entry.protocol).toBe(ENTRY_PROTOCOL);
		await expect(loadEntry(build)).resolves.toBe(entry);
	});

	it("gives the app of a plain build the trust options of the environment", async () => {
		vi.stubEnv("TRUST_FORWARDED_PROTO", "1");
		vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
		const { app } = await loadEntry({
			routes: {},
			entry: {},
			assetsBuildDirectory: "build/client",
		});
		app.get("/seen", (context) =>
			context.text(`${new URL(context.req.url).protocol} ${requestContext()?.clientAddress}`),
		);

		const response = await app.request(
			"/seen",
			{ headers: { "X-Forwarded-Proto": "https", "X-Forwarded-For": "9.9.9.9, 8.8.8.8, 7.7.7.7" } },
			{ framework: stubFramework() },
		);

		await expect(response.text()).resolves.toBe("https: 8.8.8.8");
	});

	it("stops startup for a bad value in the environment of a plain build, and names the variable", async () => {
		const build = { routes: {}, entry: {}, assetsBuildDirectory: "build/client" };
		vi.stubEnv("TRUST_FORWARDED_PROTO", "true");

		await expect(loadEntry(build)).rejects.toThrow(
			'TRUST_FORWARDED_PROTO must be "1" or "0", not "true". Set TRUST_FORWARDED_PROTO=1',
		);

		vi.stubEnv("TRUST_FORWARDED_PROTO", "1");
		vi.stubEnv("TRUSTED_PROXY_HOPS", "abc");

		await expect(loadEntry(build)).rejects.toThrow(
			'TRUSTED_PROXY_HOPS must be an integer of 0 or more, not "abc".',
		);
	});

	it("refuses to start a module that is not a React Router build", async () => {
		const entry = await loadEntry({ default: {} });

		await expect(entry.start()).rejects.toThrow("not a React Router server build");
	});
});
