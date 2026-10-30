// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:3000/dashboard"}
import { afterEach, describe, expect, it, vi } from "vitest";
import { staleBuildNavigation } from "./stale-build-navigation.js";

/** A page with a router stand-in: it handles each link click on the root, as React does. */
function page({ serverBuild }: { serverBuild: string }) {
	document.body.innerHTML = `
		<div id="root">
			<a id="settings" href="/settings">Settings</a>
			<a id="section" href="#usage">Usage</a>
			<a id="tab" href="/billing" target="_blank">Billing</a>
			<a id="file" href="/report.csv" download>Report</a>
			<a id="docs" href="https://ngrok.com/docs">Docs</a>
		</div>`;
	const requests: string[] = [];
	const server = vi.fn<typeof fetch>(async (input) => {
		requests.push(new Request(input).url);
		return new Response("data", { headers: { "X-Build-Id": serverBuild } });
	});
	vi.stubGlobal("fetch", server);
	const routed: string[] = [];
	let loaded: Promise<Response> | undefined;
	document.querySelector("#root")?.addEventListener("click", (event) => {
		const anchor = event.target instanceof Element ? event.target.closest("a") : null;
		if (anchor == null) {
			return;
		}
		event.preventDefault();
		routed.push(anchor.getAttribute("href") ?? "");
		loaded = fetch(`${anchor.pathname}.data`);
	});
	const documentLoads: string[] = [];
	vi.spyOn(location, "assign").mockImplementation((url) => {
		documentLoads.push(String(url));
	});
	const click = (id: string, init: MouseEventInit = {}) => {
		const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
		document.querySelector(`#${id}`)?.dispatchEvent(event);
		return event;
	};
	return { requests, routed, documentLoads, click, loaded: async () => loaded };
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

let stop: (() => void) | undefined;

afterEach(() => {
	stop?.();
	stop = undefined;
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

	it("loads the target as a document when the click's data comes from a new build, and the old code never gets it", async () => {
		const { requests, documentLoads, click, loaded } = page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });

		click("settings");

		await expect(settles(loaded())).resolves.toBe(false);
		expect(documentLoads).toStrictEqual(["http://localhost:3000/settings"]);
		expect(requests).toStrictEqual(["http://localhost:3000/settings.data"]);
	});

	it("sends each later click to the browser as a document load, with no request from the router", async () => {
		const { requests, routed, click } = page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });
		const background = await fetch("/poll.data");

		const event = click("settings");

		expect(background.status).toBe(200);
		expect(routed).toStrictEqual([]);
		expect(event.defaultPrevented).toBe(false);
		expect(requests).toStrictEqual(["http://localhost:3000/poll.data"]);
	});

	it("loads the target of pushState and of a history step as a document after a new build", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });
		await fetch("/poll.data");
		const here = location.href;

		history.pushState({}, "", "/usage");
		dispatchEvent(new PopStateEvent("popstate"));

		expect(documentLoads).toStrictEqual(["http://localhost:3000/usage", here]);
		expect(location.href).toBe(here);
	});

	it.each([
		["a link to a part of this page", "section", {}],
		["a link to a new window", "tab", {}],
		["a download", "file", {}],
		["a link to another origin", "docs", {}],
		["a click with a modifier key", "settings", { metaKey: true }],
	])("leaves %s to the router after a new build", async (_name, id, init) => {
		const { routed, click } = page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });
		await fetch("/poll.data");

		click(id, init);

		expect(routed).toHaveLength(1);
	});

	it("returns the response of a POST from a new build, so the action result reaches the app", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		stop = staleBuildNavigation({ build: "v1" });
		dispatchEvent(new PopStateEvent("popstate"));

		const response = await fetch("/settings.data", { method: "POST" });

		expect(response.status).toBe(200);
		expect(documentLoads).toStrictEqual([]);
	});

	it("reads the build from the document's Server-Timing, and does nothing with no build", async () => {
		const { routed, click } = page({ serverBuild: "v2" });
		const entries = vi.spyOn(performance, "getEntriesByType");
		entries.mockReturnValueOnce([]);
		const server = fetch;
		staleBuildNavigation();
		expect(fetch).toBe(server);

		entries.mockReturnValueOnce([
			Object.assign(new EventTarget(), {
				serverTiming: [{ name: "build", description: "v1", duration: 0 }],
			}) as unknown as PerformanceEntry,
		]);
		stop = staleBuildNavigation();
		await fetch("/poll.data");
		click("settings");

		expect(routed).toStrictEqual([]);
	});

	it("finds a new build in a prefetch before the click, and reports it once", async () => {
		const { routed, requests, click } = page({ serverBuild: "v2" });
		let observe: PerformanceObserverCallback | undefined;
		vi.stubGlobal(
			"PerformanceObserver",
			// oxlint-disable-next-line eslint/prefer-arrow-callback -- the code calls the stub with `new`, which an arrow function refuses.
			vi.fn(function fakeObserver(callback: PerformanceObserverCallback) {
				observe = callback;
				return { observe: () => {}, disconnect: () => {} };
			}),
		);
		const onNewBuild = vi.fn<(served: string) => void>();
		stop = staleBuildNavigation({ build: "v1", onNewBuild });
		const prefetch = { serverTiming: [{ name: "build", description: "v2", duration: 0 }] };

		observe?.(
			{ getEntries: () => [prefetch] } as unknown as PerformanceObserverEntryList,
			{} as PerformanceObserver,
		);
		await fetch("/poll.data");
		click("settings");

		expect(routed).toStrictEqual([]);
		expect(requests).toStrictEqual(["http://localhost:3000/poll.data"]);
		expect(onNewBuild).toHaveBeenCalledExactlyOnceWith("v2");
	});
});
