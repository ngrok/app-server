// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:3000/dashboard"}
import { afterEach, describe, expect, it, vi } from "vitest";
import { staleBuildNavigation } from "./stale-build-navigation.js";

type Router = "react-router" | "tanstack";

/**
 * A page with a router stand-in: it handles each link click on the root, as
 * React does. React Router fetches the data and then updates history.
 * TanStack Start updates history and then fetches the data.
 */
function page({ serverBuild, router = "react-router" }: { serverBuild: string; router?: Router }) {
	document.body.innerHTML = `
		<div id="root">
			<a id="settings" href="/settings">Settings</a>
			<a id="section" href="#usage">Usage</a>
			<a id="tab" href="/billing" target="_blank">Billing</a>
			<a id="file" href="/report.csv" download>Report</a>
			<a id="docs" href="https://ngrok.com/docs">Docs</a>
		</div>`;
	const server = { build: serverBuild };
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input) => {
			const { url } = new Request(input);
			requests.push(url);
			// Why: a proxy route of `buildId({ paths })` sends the build only in `Server-Timing`.
			const headers = url.includes("/api/")
				? { "Server-Timing": `build;desc="${server.build}"` }
				: { "X-Build-Id": server.build };
			return new Response("data", { headers });
		}),
	);
	const routed: string[] = [];
	let loaded: Promise<Response> | undefined;
	let blocked = false;
	document.querySelector("#root")?.addEventListener("click", (event) => {
		const anchor = event.target instanceof Element ? event.target.closest("a") : null;
		if (anchor == null) {
			return;
		}
		event.preventDefault();
		if (blocked) {
			return;
		}
		routed.push(anchor.getAttribute("href") ?? "");
		if (router === "tanstack") {
			history.pushState({}, "", anchor.href);
		}
		loaded = fetch(`${anchor.pathname}.data`);
	});
	const documentLoads: string[] = [];
	vi.spyOn(location, "assign").mockImplementation((url) => {
		documentLoads.push(String(url));
	});
	vi.spyOn(location, "replace").mockImplementation((url) => {
		documentLoads.push(`replace ${String(url)}`);
	});
	const click = (id: string, init: MouseEventInit = {}) => {
		const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
		document.querySelector(`#${id}`)?.dispatchEvent(event);
		return event;
	};
	const block = () => {
		blocked = true;
	};
	return { server, requests, routed, documentLoads, click, block, loaded: async () => loaded };
}

/** Whether a promise settles before the queued tasks run. */
async function settles(promise: Promise<unknown> | undefined): Promise<boolean> {
	const pending = Symbol("pending");
	const result = await Promise.race([
		promise,
		// oxlint-disable-next-line app-server/no-sleep-in-tests -- a promise that never settles needs a bounded wait to prove it.
		new Promise((resolve) => {
			setTimeout(resolve, 0, pending);
		}),
	]);
	return result !== pending;
}

/** A stand-in `PerformanceObserver` that the test feeds entries to. */
function fakeObserver() {
	let observe: PerformanceObserverCallback | undefined;
	const options: PerformanceObserverInit[] = [];
	vi.stubGlobal(
		"PerformanceObserver",
		// oxlint-disable-next-line eslint/prefer-arrow-callback -- the code calls the stub with `new`, which an arrow function refuses.
		vi.fn(function fakePerformanceObserver(callback: PerformanceObserverCallback) {
			observe = callback;
			return {
				observe: (init: PerformanceObserverInit) => options.push(init),
				disconnect: () => {},
			};
		}),
	);
	const report = (name: string, build: string) => {
		const entry = { name, serverTiming: [{ name: "build", description: build, duration: 0 }] };
		observe?.(
			{ getEntries: () => [entry] } as unknown as PerformanceObserverEntryList,
			{} as PerformanceObserver,
		);
	};
	return { options, report };
}

let stop: (() => void) | undefined;

afterEach(() => {
	stop?.();
	stop = undefined;
	history.replaceState(null, "", "/dashboard");
	vi.useRealTimers();
});

describe("staleBuildNavigation", () => {
	it("lets the router handle a click, with one request, while the server runs the same build", async () => {
		const { requests, routed, documentLoads, click, loaded } = page({ serverBuild: "v1" });
		stop = staleBuildNavigation({ build: "v1" });

		click("settings");

		await expect(loaded()).resolves.toBeInstanceOf(Response);
		expect(routed).toStrictEqual(["/settings"]);
		expect(requests).toStrictEqual(["http://localhost:3000/settings.data"]);
		expect(documentLoads).toStrictEqual([]);
	});

	it.each<Router>(["react-router", "tanstack"])(
		"with %s, loads the target as a document when the click's data comes from a new build, and the old code never gets it",
		async (router) => {
			const { requests, documentLoads, click, loaded } = page({ serverBuild: "v2", router });
			stop = staleBuildNavigation({ build: "v1" });

			click("settings");

			await expect(settles(loaded())).resolves.toBe(false);
			expect(documentLoads).toStrictEqual(["http://localhost:3000/settings"]);
			expect(requests).toStrictEqual(["http://localhost:3000/settings.data"]);
		},
	);

	it("keeps a slow data request with the navigation that started it", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { documentLoads, click } = page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });
		const answer = Promise.withResolvers<Response>();
		const server = fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => answer.promise),
		);
		stop();
		stop = staleBuildNavigation({ build: "v1" });

		click("settings");
		vi.advanceTimersByTime(60_000);
		answer.resolve(await server("/settings.data"));
		await settles(Promise.resolve());

		expect(documentLoads).toStrictEqual(["http://localhost:3000/settings"]);
	});

	it("lets the app and the router's blockers cancel a click after a new build", async () => {
		const { routed, documentLoads, click, block } = page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });
		await fetch("/poll.data");
		block();

		const event = click("settings");

		expect(event.defaultPrevented).toBe(true);
		expect(routed).toStrictEqual([]);
		expect(documentLoads).toStrictEqual([]);
	});

	it("never reloads the page that the visitor reads when a request after a history step finds a new build", async () => {
		const { server, documentLoads } = page({ serverBuild: "v1" });
		stop = staleBuildNavigation({ build: "v1" });
		history.replaceState(null, "", "/settings");
		dispatchEvent(new PopStateEvent("popstate"));
		await fetch("/settings.data");

		server.build = "v2";
		const revalidation = await fetch("/settings.data");

		expect(revalidation.status).toBe(200);
		expect(documentLoads).toStrictEqual([]);
	});

	it("never sends a click's target to a proxy route's response, such as a background query", async () => {
		const { documentLoads, click, block } = page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });
		block();
		click("settings");

		const query = await fetch("/api/keys");

		expect(query.status).toBe(200);
		expect(documentLoads).toStrictEqual([]);
	});

	it("loads the target of a history update to a new page as a document after a new build", async () => {
		const { documentLoads, requests } = page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });
		await fetch("/poll.data");

		history.pushState({}, "", "/usage");
		history.replaceState({}, "", "/keys?page=2");

		expect(documentLoads).toStrictEqual([
			"http://localhost:3000/usage",
			"replace http://localhost:3000/keys?page=2",
		]);
		expect(requests).toStrictEqual(["http://localhost:3000/poll.data"]);
		expect(location.href).toBe("http://localhost:3000/dashboard");
	});

	it("keeps history updates and steps in the same page after a new build", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });
		await fetch("/poll.data");

		history.pushState({ scroll: 1 }, "", "#usage");
		history.replaceState({ scroll: 2 }, "");
		history.pushState({ scroll: 3 }, "", location.href);
		history.replaceState(null, "", "/dashboard");
		dispatchEvent(new PopStateEvent("popstate"));

		expect(documentLoads).toStrictEqual([]);
		expect(history.state).toBeNull();
	});

	it("keeps the browser's error for a history update to another origin", async () => {
		page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });
		await fetch("/poll.data");

		expect(() => {
			history.pushState({}, "", "https://ngrok.com/");
		}).toThrow(expect.objectContaining({ name: "SecurityError" }));
	});

	it.each([
		["a link to a part of this page", "section", {}],
		["a link to a new window", "tab", {}],
		["a download", "file", {}],
		["a link to another origin", "docs", {}],
		["a click with a modifier key", "settings", { metaKey: true }],
	])("does not send a data request to %s", async (_name, id, init) => {
		const { documentLoads, click } = page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });

		click(id, init);
		const response = await fetch("/poll.data");

		expect(response.status).toBe(200);
		expect(documentLoads).toStrictEqual([]);
	});

	it("returns the response of a POST from a new build, so the action result reaches the app", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });
		history.replaceState(null, "", "/settings");
		dispatchEvent(new PopStateEvent("popstate"));

		const response = await fetch("/settings.data", { method: "POST" });

		expect(response.status).toBe(200);
		expect(documentLoads).toStrictEqual([]);
	});

	it("loads the document with no wait on a body whose cancel does not finish", async () => {
		const { documentLoads, click, loaded } = page({ serverBuild: "v2" });
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => {
				// Why: a fetch wrapper that clones the response holds the cancel until its own branch ends.
				const body = new ReadableStream({ cancel: async () => new Promise<void>(() => {}) });
				return new Response(body, { headers: { "X-Build-Id": "v2" } });
			}),
		);
		stop = staleBuildNavigation({ build: "v1" });

		click("settings");
		await settles(loaded());

		expect(documentLoads).toStrictEqual(["http://localhost:3000/settings"]);
	});

	it("ignores a build from another origin", async () => {
		const { documentLoads, click } = page({ serverBuild: "v1" });
		const { report } = fakeObserver();
		const onNewBuild = vi.fn<(served: string) => void>();
		stop = staleBuildNavigation({ build: "v1", onNewBuild });
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => {
				const response = new Response("data", { headers: { "X-Build-Id": "api-v7" } });
				Object.defineProperty(response, "url", { value: "https://api.ngrok.com/keys" });
				return response;
			}),
		);

		report("https://api.ngrok.com/keys", "api-v7");
		click("settings");
		await fetch("https://api.ngrok.com/keys");
		history.pushState({}, "", "/usage");

		expect(onNewBuild).not.toHaveBeenCalled();
		expect(documentLoads).toStrictEqual([]);
	});

	it("reads the build from the document's Server-Timing, and does nothing with no build", async () => {
		const { documentLoads, click, loaded } = page({ serverBuild: "v2" });
		const entries = vi.spyOn(performance, "getEntriesByType");
		entries.mockReturnValueOnce([]);
		const server = fetch;
		staleBuildNavigation();
		expect(fetch).toBe(server);

		entries.mockReturnValueOnce([
			Object.assign(new EventTarget(), {
				name: location.href,
				serverTiming: [{ name: "build", description: "v1", duration: 0 }],
			}) as unknown as PerformanceEntry,
		]);
		stop = staleBuildNavigation();
		click("settings");

		await expect(settles(loaded())).resolves.toBe(false);
		expect(documentLoads).toStrictEqual(["http://localhost:3000/settings"]);
	});

	it("finds a new build in a prefetch, also one before it started, and reports it once", async () => {
		const { requests, documentLoads } = page({ serverBuild: "v2" });
		const { options, report } = fakeObserver();
		const onNewBuild = vi.fn<(served: string) => void>();
		stop = staleBuildNavigation({ build: "v1", onNewBuild });

		report("http://localhost:3000/settings.data", "v2");
		await fetch("/poll.data");
		history.pushState({}, "", "/usage");

		expect(options).toStrictEqual([{ type: "resource", buffered: true }]);
		expect(documentLoads).toStrictEqual(["http://localhost:3000/usage"]);
		expect(requests).toStrictEqual(["http://localhost:3000/poll.data"]);
		expect(onNewBuild).toHaveBeenCalledExactlyOnceWith("v2");
	});
});
