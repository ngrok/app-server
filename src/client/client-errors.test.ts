// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:3000/domains/42?tab=usage"}
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clientErrorsReactRouter,
	clientErrorsScript,
	clientErrorsTanStack,
} from "./client-errors.js";

/** An error whose stack says that a chunk of this page threw it, as Chromium writes it. */
function ownError(message: string, file = "http://localhost:3000/assets/usage-3f9a1c.js"): Error {
	const error = new TypeError(message);
	error.stack = `TypeError: ${message}\n    at Usage (${file}:12:34)`;
	return error;
}

/** The `error` event of `window` for `error`. */
function errorEvent(error: unknown): Event {
	return Object.assign(new Event("error"), { error });
}

/** The listeners that a test added to `window`, so the next test starts with none. */
const added: [string, EventListenerOrEventListenerObject][] = [];

/** Stubs `fetch`, and gives the body of each report that the page sends. */
function page() {
	const send = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
	vi.stubGlobal("fetch", send);
	const add = globalThis.addEventListener.bind(globalThis);
	vi.spyOn(globalThis, "addEventListener").mockImplementation(
		(type: string, listener: EventListenerOrEventListenerObject) => {
			added.push([type, listener]);
			add(type, listener);
		},
	);
	return {
		send,
		reports: (): Record<string, unknown>[] =>
			send.mock.calls.map(
				([, init]) =>
					JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
			),
	};
}

afterEach(() => {
	for (const [type, listener] of added.splice(0)) {
		removeEventListener(type, listener);
	}
	Reflect.deleteProperty(globalThis, "__appServerErrors");
});

describe("clientErrorsReactRouter", () => {
	it("posts one report for an error event of the page, with no cookie", async () => {
		const { send, reports } = page();
		clientErrorsReactRouter();

		dispatchEvent(errorEvent(ownError("no id")));

		expect(send).toHaveBeenCalledExactlyOnceWith("/_app/issues", {
			method: "POST",
			keepalive: true,
			credentials: "omit",
			headers: { "Content-Type": "application/json" },
			body: expect.any(String),
		});
		expect(reports()).toStrictEqual([
			{
				name: "TypeError",
				message: "no id",
				stack: "    at Usage (http://localhost:3000/assets/usage-3f9a1c.js:12:34)",
				source: "error",
				path: "/domains/42",
			},
		]);
	});

	it("posts a report for a rejected promise with no handler, to the clientErrorsPath of the Vite plugin", () => {
		const { send, reports } = page();
		// Vite writes this constant into the client build.
		vi.stubGlobal("__APP_SERVER_CLIENT_ERRORS_PATH__", "/_x");
		clientErrorsReactRouter();

		dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: ownError("rejected") }));

		expect(send.mock.calls[0]?.[0]).toBe("/_x");
		expect(reports()[0]?.source).toBe("unhandledrejection");
	});

	it("sends the build of the document, which buildId() gives in Server-Timing", () => {
		const { reports } = page();
		vi.spyOn(performance, "getEntriesByType").mockReturnValue([
			{
				name: "http://localhost:3000/domains/42",
				entryType: "navigation",
				serverTiming: [{ name: "build", description: "v41" }],
			} as unknown as PerformanceEntry,
		]);
		clientErrorsReactRouter();

		dispatchEvent(errorEvent(ownError("no id")));

		expect(reports()[0]?.build).toBe("v41");
	});

	it("drops an error that code of another origin threw, and a value that is not an error", () => {
		const { send } = page();
		clientErrorsReactRouter();
		const masked = new Error("Script error.");
		masked.stack = "";
		const fromOwnMessage = ownError("x", "chrome-extension://abcdef/content.js");
		fromOwnMessage.message = "Failed to load http://localhost:3000/assets/a.js";
		fromOwnMessage.stack = `Error: ${fromOwnMessage.message}\n    at chrome-extension://abcdef/content.js:1:2`;

		for (const thrown of [
			ownError("extension", "chrome-extension://abcdef/content.js"),
			ownError("third party", "https://cdn.example.com/widget.js"),
			fromOwnMessage,
			masked,
			"a string",
			undefined,
		]) {
			dispatchEvent(errorEvent(thrown));
		}

		expect(send).not.toHaveBeenCalled();
	});

	it("reports a Firefox or Safari error whose message is a part of the URL of its frame", () => {
		const { reports } = page();
		clientErrorsReactRouter();
		const error = new Error("localhost");
		error.stack = "load@http://localhost:3000/assets/usage-3f9a1c.js:1:2";

		dispatchEvent(errorEvent(error));

		expect(reports().map((report) => report.stack)).toStrictEqual([
			"load@http://localhost:3000/assets/usage-3f9a1c.js:1:2",
		]);
	});

	it("keeps the frames of an error with a long message, in a body of 6 KiB or less", () => {
		const { send, reports } = page();
		clientErrorsReactRouter();

		dispatchEvent(errorEvent(ownError("x".repeat(11_000))));
		dispatchEvent(errorEvent(ownError("界".repeat(6000))));
		const deep = ownError("deep");
		deep.stack += "\n    at 界 (http://localhost:3000/assets/界.js:1:2)".repeat(400);
		dispatchEvent(errorEvent(deep));

		expect(reports().map((report) => String(report.stack).split("\n")[0])).toStrictEqual([
			"    at Usage (http://localhost:3000/assets/usage-3f9a1c.js:12:34)",
			"    at Usage (http://localhost:3000/assets/usage-3f9a1c.js:12:34)",
			"    at Usage (http://localhost:3000/assets/usage-3f9a1c.js:12:34)",
		]);
		for (const [, init] of send.mock.calls) {
			const body = typeof init?.body === "string" ? init.body : "";

			expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(6 * 1024);
		}
	});

	it("reports a Chromium error whose message ends as a frame of another origin does", () => {
		const { reports } = page();
		clientErrorsReactRouter();

		dispatchEvent(errorEvent(ownError("failed at https://cdn.example.net/a.js:1:2")));

		expect(reports().map((report) => report.stack)).toStrictEqual([
			"    at Usage (http://localhost:3000/assets/usage-3f9a1c.js:12:34)",
		]);
	});

	it("sends 64 KiB or less in the 10 reports of a page load, the limit of keepalive", () => {
		const { send } = page();
		clientErrorsReactRouter();

		for (let count = 0; count < 10; count += 1) {
			const deep = ownError(`deep ${count}`);
			deep.stack += "\n    at 界 (http://localhost:3000/assets/界.js:1:2)".repeat(400);
			dispatchEvent(errorEvent(deep));
		}
		const bytes = send.mock.calls.map(([, init]) =>
			typeof init?.body === "string" ? new TextEncoder().encode(init.body).length : 0,
		);

		expect(bytes).toHaveLength(10);
		expect(bytes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(64 * 1024);
	});

	it("sends the first 10 kept events when the page hides and the module did not start", () => {
		const { send, reports } = page();
		vi.stubGlobal("__APP_SERVER_CLIENT_ERRORS_PATH__", "/_x");
		// oxlint-disable-next-line no-eval -- the browser runs this text as an inline script.
		globalThis.eval(clientErrorsScript());
		dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: ownError("early") }));
		dispatchEvent(errorEvent("a string"));
		for (let count = 0; count < 12; count += 1) {
			dispatchEvent(errorEvent(ownError(`loop ${count}`)));
		}

		expect(send).not.toHaveBeenCalled();

		dispatchEvent(new Event("pagehide"));
		// A page that the browser shows again from its cache, and then hides again.
		dispatchEvent(new Event("pagehide"));

		// The string is one of the first 10 events, and it gives no report.
		expect(send).toHaveBeenCalledTimes(9);
		expect(send.mock.calls[0]).toStrictEqual([
			"/_x",
			{ method: "POST", keepalive: true, credentials: "omit", body: expect.any(String) },
		]);
		expect(reports()[0]).toStrictEqual({
			name: "TypeError",
			message: "early",
			stack: "TypeError: early\n    at Usage (http://localhost:3000/assets/usage-3f9a1c.js:12:34)",
			source: "unhandledrejection",
			path: "/domains/42",
		});
	});

	it("sends nothing from the inline script after the module took the events", () => {
		const { send } = page();
		// oxlint-disable-next-line no-eval -- the browser runs this text as an inline script.
		globalThis.eval(clientErrorsScript());
		dispatchEvent(errorEvent(ownError("before the entry")));
		clientErrorsReactRouter();

		dispatchEvent(new Event("pagehide"));

		expect(send).toHaveBeenCalledTimes(1);
	});

	it("keeps 100 events at most in the inline script", () => {
		page();
		// oxlint-disable-next-line no-eval -- the browser runs this text as an inline script.
		globalThis.eval(clientErrorsScript());
		const buffer: { events: Event[]; keep: (event: Event) => void } = Reflect.get(
			globalThis,
			"__appServerErrors",
		);
		added.push(["error", buffer.keep], ["unhandledrejection", buffer.keep]);

		for (let count = 0; count < 150; count += 1) {
			dispatchEvent(errorEvent(ownError(`loop ${count}`)));
		}

		expect(buffer.events).toHaveLength(100);
	});

	it("sends each error once, and 10 reports at most for a page load", () => {
		const { send } = page();
		clientErrorsReactRouter();
		const repeated = ownError("again");

		dispatchEvent(errorEvent(repeated));
		dispatchEvent(errorEvent(repeated));

		expect(send).toHaveBeenCalledTimes(1);

		for (let count = 0; count < 20; count += 1) {
			dispatchEvent(errorEvent(ownError(`loop ${count}`)));
		}

		expect(send).toHaveBeenCalledTimes(10);
	});

	it("reports the events that the inline script kept before the module ran", () => {
		const { reports } = page();
		// oxlint-disable-next-line no-eval -- the browser runs this text as an inline script.
		globalThis.eval(clientErrorsScript());
		dispatchEvent(errorEvent(ownError("before the entry")));
		dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: ownError("early") }));

		clientErrorsReactRouter();
		dispatchEvent(errorEvent(ownError("after the entry")));

		expect(reports().map((report) => [report.message, report.source])).toStrictEqual([
			["before the entry", "error"],
			["early", "unhandledrejection"],
			["after the entry", "error"],
		]);
		// The inline script listens no more, so the page keeps no event.
		expect(Reflect.get(globalThis, "__appServerErrors")).toMatchObject({ events: [] });
	});

	it("reports an error of the router with its route pattern", () => {
		const { reports } = page();
		const { onError } = clientErrorsReactRouter();

		onError(ownError("loader failed"), { pattern: "/domains/:domainId" });
		onError({ status: 404, data: "Not Found" }, { pattern: "/domains/:domainId" });

		expect(reports().map((report) => [report.source, report.route])).toStrictEqual([
			["router", "/domains/:domainId"],
		]);
	});

	it("reports the render error of a route once, with the route pattern of the router", async () => {
		const { reports } = page();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { onError, rootOptions } = clientErrorsReactRouter();
		const error = ownError("render failed");

		// React calls the root option first, and then the error boundary of the router.
		rootOptions.onCaughtError(error);
		onError(error, { pattern: "/domains/:domainId" });
		await Promise.resolve();

		expect(reports().map((report) => [report.source, report.route])).toStrictEqual([
			["router", "/domains/:domainId"],
		]);
	});

	it("reports the errors of the React root, and then does what React does with no option", async () => {
		const { reports } = page();
		const reportGlobal = vi.fn<typeof reportError>();
		vi.stubGlobal("reportError", reportGlobal);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const { rootOptions } = clientErrorsReactRouter();
		const [uncaught, caught, recoverable] = [ownError("a"), ownError("b"), ownError("c")];

		rootOptions.onUncaughtError(uncaught);
		rootOptions.onCaughtError(caught);
		rootOptions.onRecoverableError(recoverable);
		await Promise.resolve();

		expect(reports().map((report) => report.source)).toStrictEqual([
			"uncaught",
			"recoverable",
			"caught",
		]);
		expect(reportGlobal.mock.calls).toStrictEqual([[uncaught], [recoverable]]);
		expect(log).toHaveBeenCalledExactlyOnceWith(caught);
	});
});

describe("clientErrorsTanStack", () => {
	it("reports the errors of the page and of the React root", async () => {
		const { reports } = page();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { rootOptions } = clientErrorsTanStack();

		dispatchEvent(errorEvent(ownError("event")));
		rootOptions.onCaughtError(ownError("loader failed"));
		await Promise.resolve();

		expect(reports().map((report) => [report.message, report.source])).toStrictEqual([
			["event", "error"],
			["loader failed", "caught"],
		]);
	});
});
