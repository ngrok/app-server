// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:3000/dashboard"}
import {
	createBrowserHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import { createBrowserRouter } from "react-router";
import type { DataStrategyResult, MiddlewareFunction } from "react-router";
import type { HydratedRouterProps } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { staleBuildReactRouter, staleBuildTanStack } from "./stale-build-navigation.js";

/** A server stand-in that answers each request with its build, and the document loads of the page. */
function page({ serverBuild }: { serverBuild: string }) {
	const server = { build: serverBuild };
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const { url } = new Request(input, init);
			requests.push(url);
			// Why: a proxy route of `buildId({ paths })` sends the build only in `Server-Timing`.
			const headers = url.includes("/api/")
				? { "Server-Timing": `build;desc="${server.build}"` }
				: { "X-Build-Id": server.build };
			return new Response("data", { headers });
		}),
	);
	const documentLoads: string[] = [];
	vi.spyOn(location, "assign").mockImplementation((url) => {
		documentLoads.push(String(url));
	});
	vi.spyOn(location, "replace").mockImplementation((url) => {
		documentLoads.push(`replace ${String(url)}`);
	});
	vi.spyOn(location, "reload").mockImplementation(() => {
		documentLoads.push(`reload ${location.href}`);
	});
	return { server, requests, documentLoads };
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
	const report = (name: string, builds: string | string[], { redirected = false } = {}) => {
		const entries = [builds].flat().map((build) => ({
			name,
			entryType: "resource",
			redirectStart: redirected ? 1 : 0,
			serverTiming: [{ name: "build", description: build, duration: 0 }],
		}));
		observe?.(
			{ getEntries: () => entries } as unknown as PerformanceObserverEntryList,
			{} as PerformanceObserver,
		);
	};
	return { options, report };
}

/** A React Router data request, as single fetch sends it. */
function dataRequest(path: string, init?: RequestInit): Request {
	return new Request(new URL(path, location.href), init);
}

const PUSH = { type: "navigation", navigationType: "PUSH" } as const;

/** A `staleBuildReactRouter()` that React Router already started, as at router creation. */
function started(options?: Parameters<typeof staleBuildReactRouter>[0]) {
	const staleBuild = staleBuildReactRouter(options);
	instrumentations(staleBuild);
	return staleBuild;
}

/** The router instrumentations that `staleBuild` adds, as React Router gets them. */
function instrumentations(staleBuild: ReturnType<typeof staleBuildReactRouter>) {
	let added: Parameters<Parameters<typeof staleBuild.instrumentation.router>[0]["instrument"]>[0];
	staleBuild.instrumentation.router({
		instrument: (hooks) => {
			added = hooks;
		},
	});
	// @ts-expect-error -- `instrument` runs before the return.
	return added;
}

/** The middleware calls of navigations, with the arguments that React Router gives them. */
function navigationCalls(staleBuild: ReturnType<typeof staleBuildReactRouter>) {
	return async <Result>(
		path: string,
		next: () => Promise<Result>,
		{ method = "GET", navigationType = "PUSH" } = {},
	): Promise<Result> => {
		const args = {
			request: dataRequest(path, { method }),
			unstable_initiator: "navigation",
			unstable_navigationType: navigationType,
		};
		return staleBuild.middleware(args, next);
	};
}

/** The functions that undo what a test started. */
const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) {
		cleanup();
	}
	history.replaceState(null, "", "/dashboard");
});

describe("staleBuildReactRouter", () => {
	it("fits the props of `HydratedRouter` and the `clientMiddleware` of a route", () => {
		const staleBuild = staleBuildReactRouter({ build: "v1" });
		const props = {
			unstable_fetch: staleBuild.fetch,
			instrumentations: [staleBuild.instrumentation],
		} satisfies HydratedRouterProps;
		const clientMiddleware: MiddlewareFunction<Record<string, DataStrategyResult>>[] = [
			staleBuild.middleware,
		];

		expect(props.instrumentations).toHaveLength(1);
		expect(clientMiddleware).toHaveLength(1);
	});

	it("reads no browser state until React Router calls it, so the server can import it", () => {
		const entries = vi.spyOn(performance, "getEntriesByType");

		staleBuildReactRouter();

		expect(entries).not.toHaveBeenCalled();
	});

	it("keeps the fragment of the `navigate` call when the data comes from a new build", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const staleBuild = staleBuildReactRouter({ build: "v1" });
		const { navigate } = instrumentations(staleBuild);
		let data: Promise<Response> | undefined;

		void navigate(
			async () =>
				navigationCalls(staleBuild)("/settings", async () => {
					data = staleBuild.fetch(dataRequest("/settings.data"), PUSH);
					return data;
				}),
			{ to: "/settings#usage" },
		);

		await expect(settles(data)).resolves.toBe(false);
		expect(documentLoads).toStrictEqual(["http://localhost:3000/settings#usage"]);
	});

	it("drops the fragment of the `navigate` call at a redirect to another page", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const staleBuild = staleBuildReactRouter({ build: "v1" });
		const { navigate } = instrumentations(staleBuild);
		let data: Promise<Response> | undefined;

		void navigate(
			async () =>
				navigationCalls(staleBuild)("/settings", async () => {
					// Why `/login`: a client loader of `/settings` redirects with no `navigate` call.
					data = staleBuild.fetch(dataRequest("/login.data"), PUSH);
					return data;
				}),
			{ to: "/settings#usage" },
		);

		await expect(settles(data)).resolves.toBe(false);
		expect(documentLoads).toStrictEqual(["http://localhost:3000/login"]);
	});

	it("loads the page as a document when a navigation removes the fragment", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const routerFetch = started({ build: "v1" }).fetch;
		history.replaceState(null, "", "/dashboard#usage");

		const data = routerFetch(dataRequest("/dashboard.data"), PUSH);

		await expect(settles(data)).resolves.toBe(false);
		expect(documentLoads).toStrictEqual(["http://localhost:3000/dashboard"]);
	});

	it("returns the data of a navigation with one request while the server runs the same build", async () => {
		const { requests, documentLoads } = page({ serverBuild: "v1" });
		const routerFetch = started({ build: "v1" }).fetch;

		const response = await routerFetch(dataRequest("/settings.data?_routes=root"), PUSH);

		await expect(response.text()).resolves.toBe("data");
		expect(requests).toStrictEqual(["http://localhost:3000/settings.data?_routes=root"]);
		expect(documentLoads).toStrictEqual([]);
	});

	it.each([
		["PUSH", "/settings.data?_routes=root,routes/settings", "http://localhost:3000/settings"],
		["PUSH", "/docs/_.data?q=a%20b&_routes=root", "http://localhost:3000/docs/?q=a+b"],
		["PUSH", "/_.data", "http://localhost:3000/"],
		["REPLACE", "/keys.data?page=2", "replace http://localhost:3000/keys?page=2"],
	])(
		"loads the target of a %s navigation to %s as a document when the data comes from a new build",
		async (navigationType, path, load) => {
			const { documentLoads } = page({ serverBuild: "v2" });
			const routerFetch = started({ build: "v1" }).fetch;

			const data = routerFetch(dataRequest(path), { type: "navigation", navigationType });

			await expect(settles(data)).resolves.toBe(false);
			expect(documentLoads).toStrictEqual([load]);
		},
	);

	it("reloads the document for a history step, because the browser already moved history", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const routerFetch = started({ build: "v1" }).fetch;
		history.replaceState(null, "", "/settings?q=a%20b#usage");

		const data = routerFetch(dataRequest("/settings.data?q=a%20b"), {
			type: "navigation",
			navigationType: "POP",
		});

		await expect(settles(data)).resolves.toBe(false);
		expect(documentLoads).toStrictEqual(["reload http://localhost:3000/settings?q=a%20b#usage"]);
	});

	it.each(["revalidation", "fetcher", "initialization"])(
		"gives a %s request its response from a new build, and the next navigation loads with no request",
		async (type) => {
			const { requests, documentLoads } = page({ serverBuild: "v2" });
			const onNewBuild = vi.fn<(served: string) => void>();
			const routerFetch = started({ build: "v1", onNewBuild }).fetch;

			const response = await routerFetch(dataRequest("/dashboard.data"), {
				type,
				navigationType: null,
			});
			const data = routerFetch(dataRequest("/settings.data"), PUSH);

			expect(response.status).toBe(200);
			await expect(settles(data)).resolves.toBe(false);
			expect(documentLoads).toStrictEqual(["http://localhost:3000/settings"]);
			expect(requests).toStrictEqual(["http://localhost:3000/dashboard.data"]);
			expect(onNewBuild).toHaveBeenCalledExactlyOnceWith("v2");
		},
	);

	it("answers the request when onNewBuild throws, and reports the error", async () => {
		page({ serverBuild: "v2" });
		const reported = vi.fn<(error: unknown) => void>();
		vi.stubGlobal("reportError", reported);
		const failure = new Error("no RUM yet");
		const routerFetch = started({
			build: "v1",
			onNewBuild: () => {
				throw failure;
			},
		}).fetch;

		const response = await routerFetch(dataRequest("/dashboard.data"), {
			type: "revalidation",
			navigationType: null,
		});

		expect(response.status).toBe(200);
		expect(reported).toHaveBeenCalledExactlyOnceWith(failure);
	});

	it("reloads the old document when the back/forward cache shows it again", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const routerFetch = started({ build: "v1" }).fetch;

		void routerFetch(dataRequest("/settings.data"), PUSH);
		await vi.waitFor(() => {
			expect(documentLoads).toStrictEqual(["http://localhost:3000/settings"]);
		});
		dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));

		expect(documentLoads).toStrictEqual([
			"http://localhost:3000/settings",
			"reload http://localhost:3000/dashboard",
		]);
	});

	it.each([
		["an action", true],
		["a `clientAction` with no request", false],
	])(
		"returns the loaders after %s from a new build, so the form keeps its result",
		async (_, isServerAction) => {
			const { documentLoads } = page({ serverBuild: "v2" });
			const staleBuild = started({ build: "v1" });
			const call = navigationCalls(staleBuild);

			// Why two signals: a browser gives each `Request` its own signal.
			const action = await call(
				"/settings",
				async () =>
					isServerAction
						? staleBuild.fetch(dataRequest("/settings.data", { method: "POST" }), PUSH)
						: undefined,
				{ method: "POST" },
			);
			// Why two loader requests: a `clientLoader` that calls `serverLoader()` gets its own request.
			const loaders = await call("/settings", async () =>
				Promise.all([
					staleBuild.fetch(dataRequest("/settings.data?_routes=root"), PUSH),
					staleBuild.fetch(dataRequest("/settings.data?_routes=routes/settings"), PUSH),
				]),
			);
			const next = staleBuild.fetch(dataRequest("/usage.data"), PUSH);

			expect(action?.status ?? 200).toBe(200);
			expect(loaders.map((response) => response.status)).toStrictEqual([200, 200]);
			await expect(settles(next)).resolves.toBe(false);
			expect(documentLoads).toStrictEqual(["http://localhost:3000/usage"]);
		},
	);

	it("keeps the mark of an action when a blocker stops another navigation", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const staleBuild = staleBuildReactRouter({ build: "v1" });
		const { navigate } = instrumentations(staleBuild);
		const call = navigationCalls(staleBuild);
		const answer = Promise.withResolvers<undefined>();
		const action = call("/settings", async () => answer.promise, { method: "POST" });

		// Why no middleware call: a blocker stops the navigation before the router loads it.
		await navigate(async () => undefined, { to: "/usage" });
		answer.resolve(undefined);
		await action;
		const loaders = await call("/settings", async () =>
			staleBuild.fetch(dataRequest("/settings.data"), PUSH),
		);

		expect(loaders.status).toBe(200);
		expect(documentLoads).toStrictEqual([]);
	});

	it("keeps the mark of a newer action when the loaders of an older one end", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const staleBuild = started({ build: "v1" });
		const call = navigationCalls(staleBuild);
		await call("/a", async () => undefined, { method: "POST" });
		const older = Promise.withResolvers<undefined>();
		const olderLoaders = call("/a", async () => older.promise);

		await call("/b", async () => undefined, { method: "POST" });
		older.resolve(undefined);
		await olderLoaders;
		const loaders = await call("/b", async () => staleBuild.fetch(dataRequest("/b.data"), PUSH));

		expect(loaders.status).toBe(200);
		expect(documentLoads).toStrictEqual([]);
	});

	it("loads the page of an action as a document at a later navigation after a redirect", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const staleBuild = started({ build: "v1" });
		const call = navigationCalls(staleBuild);
		await call("/settings", async () => undefined, { method: "POST" });
		await call("/done", async () => undefined);

		const later = call("/settings", async () =>
			staleBuild.fetch(dataRequest("/settings.data"), PUSH),
		);

		await expect(settles(later)).resolves.toBe(false);
		expect(documentLoads).toStrictEqual(["http://localhost:3000/settings"]);
	});

	it("reloads a history step to the page of an action after its loaders ran", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const staleBuild = started({ build: "v1" });
		const call = navigationCalls(staleBuild);
		await call(
			"/settings?page=2",
			async () => staleBuild.fetch(dataRequest("/settings.data?page=2", { method: "POST" }), PUSH),
			{ method: "POST" },
		);
		await call("/settings?page=2", async () =>
			staleBuild.fetch(dataRequest("/settings.data?page=2"), PUSH),
		);
		history.replaceState(null, "", "/settings");

		const back = call(
			"/settings",
			async () =>
				staleBuild.fetch(dataRequest("/settings.data"), {
					type: "navigation",
					navigationType: "POP",
				}),
			{ navigationType: "POP" },
		);

		await expect(settles(back)).resolves.toBe(false);
		expect(documentLoads).toStrictEqual(["reload http://localhost:3000/settings"]);
	});

	it("loads the document once for parallel requests of a navigation, and again after the router cancels it", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const routerFetch = started({ build: "v1" }).fetch;
		const first = new AbortController();

		const root = routerFetch(
			dataRequest("/settings.data?_routes=root", { signal: first.signal }),
			PUSH,
		);
		const child = routerFetch(
			dataRequest("/settings.data?_routes=routes/settings", { signal: first.signal }),
			PUSH,
		);
		await settles(Promise.all([root, child]));
		first.abort();
		const again = routerFetch(dataRequest("/settings.data"), PUSH);

		await expect(settles(again)).resolves.toBe(false);
		expect(documentLoads).toStrictEqual([
			"http://localhost:3000/settings",
			"http://localhost:3000/settings",
		]);
	});

	it("gives a fetcher that a navigation revalidates its response from a new build", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const routerFetch = started({ build: "v1" }).fetch;

		const response = await routerFetch(dataRequest("/notifications.data"), {
			...PUSH,
			fetcherKey: "notifications",
		});

		expect(response.status).toBe(200);
		expect(documentLoads).toStrictEqual([]);
	});

	it("never loads the target of a canceled navigation", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const send = fetch;
		const answer = Promise.withResolvers<undefined>();
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input, init) => {
				await answer.promise;
				return send(input, init);
			}),
		);
		const routerFetch = started({ build: "v1" }).fetch;
		const navigation = new AbortController();
		const slow = routerFetch(dataRequest("/settings.data", { signal: navigation.signal }), PUSH);

		navigation.abort();
		answer.resolve(undefined);
		const late = await slow;
		const canceled = routerFetch(dataRequest("/usage.data", { signal: navigation.signal }), PUSH);

		expect(late.status).toBe(200);
		await expect(canceled).resolves.toHaveProperty("status", 200);
		expect(documentLoads).toStrictEqual([]);
	});

	it("loads the document with no wait on a body whose cancel does not finish", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => {
				// Why: a fetch wrapper that clones the response holds the cancel until its own branch ends.
				const body = new ReadableStream({ cancel: async () => new Promise<void>(() => {}) });
				return new Response(body, { headers: { "X-Build-Id": "v2" } });
			}),
		);
		const routerFetch = started({ build: "v1" }).fetch;

		await settles(routerFetch(dataRequest("/settings.data"), PUSH));

		expect(documentLoads).toStrictEqual(["http://localhost:3000/settings"]);
	});

	it("ignores a build from another origin", async () => {
		const { documentLoads } = page({ serverBuild: "v1" });
		const { report } = fakeObserver();
		const onNewBuild = vi.fn<(served: string) => void>();
		const routerFetch = started({ build: "v1", onNewBuild }).fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () => {
				const response = new Response("data", { headers: { "X-Build-Id": "api-v7" } });
				Object.defineProperty(response, "url", { value: "https://api.ngrok.com/keys" });
				return response;
			}),
		);

		report("https://api.ngrok.com/keys", "api-v7");
		const response = await routerFetch(dataRequest("/settings.data"), PUSH);

		expect(response.status).toBe(200);
		expect(onNewBuild).not.toHaveBeenCalled();
		expect(documentLoads).toStrictEqual([]);
	});

	it("finds a new build in any entry of a resource batch, and loads the next navigation", async () => {
		const { requests, documentLoads } = page({ serverBuild: "v2" });
		const { options, report } = fakeObserver();
		const onNewBuild = vi.fn<(served: string) => void>();
		const routerFetch = started({ build: "v1", onNewBuild }).fetch;

		report("http://localhost:3000/api/keys", ["v1", "v2"]);
		await settles(routerFetch(dataRequest("/settings.data"), PUSH));

		expect(options).toStrictEqual([{ type: "resource", buffered: true }]);
		expect(documentLoads).toStrictEqual(["http://localhost:3000/settings"]);
		expect(requests).toStrictEqual([]);
		expect(onNewBuild).toHaveBeenCalledExactlyOnceWith("v2");
	});

	it("ignores the build of a prefetch that a redirect can move to another origin", async () => {
		const { documentLoads } = page({ serverBuild: "v1" });
		const { report } = fakeObserver();
		const onNewBuild = vi.fn<(served: string) => void>();
		const routerFetch = started({ build: "v1", onNewBuild }).fetch;

		report("http://localhost:3000/go/status", "v9", { redirected: true });
		const response = await routerFetch(dataRequest("/settings.data"), PUSH);

		expect(response.status).toBe(200);
		expect(onNewBuild).not.toHaveBeenCalled();
		expect(documentLoads).toStrictEqual([]);
	});

	it("reads the build from the document's Server-Timing, and does nothing with no build", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const entries = vi.spyOn(performance, "getEntriesByType");
		entries.mockReturnValueOnce([]);
		const noBuild = started().fetch;
		entries.mockReturnValueOnce([
			Object.assign(new EventTarget(), {
				name: location.href,
				redirectStart: 1,
				serverTiming: [{ name: "build", description: "v1", duration: 0 }],
			}) as unknown as PerformanceEntry,
		]);
		const routerFetch = started().fetch;

		const response = await noBuild(dataRequest("/settings.data"), PUSH);
		await settles(routerFetch(dataRequest("/settings.data"), PUSH));

		expect(response.status).toBe(200);
		expect(documentLoads).toStrictEqual(["http://localhost:3000/settings"]);
	});
});

describe("staleBuildReactRouter with a real router and no loaders", () => {
	/** A React Router with the root middleware and the instrumentation, and routes with no loader. */
	function reactRouter(staleBuild: ReturnType<typeof staleBuildReactRouter>) {
		const router = createBrowserRouter(
			[
				{
					id: "root",
					path: "/",
					middleware: [staleBuild.middleware],
					children: [
						{ path: "dashboard" },
						{ path: "settings", action: () => "saved" },
						{ path: "usage" },
						{ path: "notifications", loader: async () => new Promise(() => {}) },
					],
				},
			],
			{ instrumentations: [staleBuild.instrumentation] },
		);
		cleanups.push(() => {
			router.dispose();
		});
		return router;
	}

	it("moves to the target with the router while the server runs the same build", async () => {
		const { documentLoads } = page({ serverBuild: "v1" });
		const router = reactRouter(staleBuildReactRouter({ build: "v1" }));

		await router.navigate("/settings");

		expect(router.state.location.pathname).toBe("/settings");
		expect(location.pathname).toBe("/settings");
		expect(documentLoads).toStrictEqual([]);
	});

	it("loads the target with its fragment as a document after a new build, before the old code renders it", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { report } = fakeObserver();
		const router = reactRouter(staleBuildReactRouter({ build: "v1" }));
		report("http://localhost:3000/api/keys", "v2");

		const navigation = router.navigate("/settings#usage");

		await expect(settles(navigation)).resolves.toBe(false);
		expect(documentLoads).toStrictEqual(["http://localhost:3000/settings#usage"]);
		expect(router.state.location.pathname).toBe("/dashboard");
	});

	it("keeps a replace navigation a replace when it loads the target as a document", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { report } = fakeObserver();
		const router = reactRouter(staleBuildReactRouter({ build: "v1" }));
		report("http://localhost:3000/api/keys", "v2");

		void router.navigate("/settings", { replace: true });

		await vi.waitFor(() => {
			expect(documentLoads).toStrictEqual(["replace http://localhost:3000/settings"]);
		});
	});

	it("loads the target of a navigation as a document while a fetcher runs", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { report } = fakeObserver();
		const router = reactRouter(staleBuildReactRouter({ build: "v1" }));
		report("http://localhost:3000/api/keys", "v2");

		void router.fetch("notifications", "root", "/notifications");
		void router.navigate("/usage");

		await vi.waitFor(() => {
			expect(documentLoads).toStrictEqual(["http://localhost:3000/usage"]);
		});
		expect(router.state.location.pathname).toBe("/dashboard");
	});

	it("loads the target with its fragment as a document when a blocker lets the navigation go on", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { report } = fakeObserver();
		const router = reactRouter(staleBuildReactRouter({ build: "v1" }));
		report("http://localhost:3000/api/keys", "v2");
		router.getBlocker("unsaved", () => true);

		await router.navigate("/settings#usage");
		router.state.blockers.get("unsaved")?.proceed?.();

		await vi.waitFor(() => {
			expect(documentLoads).toStrictEqual(["http://localhost:3000/settings#usage"]);
		});
		expect(router.state.location.pathname).toBe("/dashboard");
	});

	it("lets a blocker cancel the navigation after a new build", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { report } = fakeObserver();
		const router = reactRouter(staleBuildReactRouter({ build: "v1" }));
		report("http://localhost:3000/api/keys", "v2");
		router.getBlocker("unsaved", () => true);

		await router.navigate("/settings");

		expect(router.state.location.pathname).toBe("/dashboard");
		expect(documentLoads).toStrictEqual([]);
	});

	it("never reloads at a revalidation, and lets a form submission to another route run its action", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { report } = fakeObserver();
		const router = reactRouter(staleBuildReactRouter({ build: "v1" }));
		report("http://localhost:3000/api/keys", "v2");

		await router.revalidate();
		await router.navigate("/settings", { formMethod: "POST", formData: new FormData() });

		expect(router.state.actionData).toStrictEqual({ "0-1": "saved" });
		expect(documentLoads).toStrictEqual([]);
	});

	it("takes only the first middleware call of a navigation, not the fetchers that it revalidates", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { report } = fakeObserver();
		const staleBuild = staleBuildReactRouter({ build: "v1" });
		const { navigate } = instrumentations(staleBuild);
		report("http://localhost:3000/api/keys", "v2");
		let fetcher: Promise<string> | undefined;

		// Why these fields: React Router gives the middleware the arguments of its data strategy.
		const call = (path: string) => ({
			request: dataRequest(path),
			unstable_initiator: "navigation",
			unstable_navigationType: "PUSH",
		});

		void navigate(
			async () => {
				void staleBuild.middleware(call("/settings"), async () => "next");
				fetcher = staleBuild.middleware(call("/notifications"), async () => "next");
				return fetcher;
			},
			{ to: "/settings" },
		);

		await expect(fetcher).resolves.toBe("next");
		expect(documentLoads).toStrictEqual(["http://localhost:3000/settings"]);
	});
});

describe("staleBuildTanStack", () => {
	/** A TanStack router whose loaders call `serverFns` in turn, as server functions do. */
	function tanstack(serverFns: Record<string, string[]> = {}) {
		const rootRoute = createRootRoute();
		const loaded: string[] = [];
		const route = (path: string) =>
			createRoute({
				getParentRoute: () => rootRoute,
				path,
				loader: async () => {
					for (const serverFn of serverFns[path] ?? []) {
						// oxlint-disable-next-line no-await-in-loop -- a loader can call its server functions in turn.
						await fetch(serverFn);
					}
					loaded.push(path);
				},
			});
		const router = createRouter({
			routeTree: rootRoute.addChildren([route("/dashboard"), route("/settings"), route("/usage")]),
			history: createBrowserHistory(),
		});
		// Why: `RouterProvider` loads the router at each history change, after the blockers.
		cleanups.push(
			router.history.subscribe(() => {
				void router.load();
			}),
		);
		return { router, loaded };
	}

	it("does nothing on the server, where there is no tab to move", async () => {
		const send = fetch;
		const { router } = tanstack();
		vi.stubGlobal("document", undefined);

		cleanups.push(staleBuildTanStack(router, { build: "v1" }));

		expect(fetch).toBe(send);
	});

	it("lets a navigation load its data, and gives a later request from a new build its response", async () => {
		const { server, requests, documentLoads } = page({ serverBuild: "v1" });
		const { router, loaded } = tanstack({ "/settings": ["/_serverFn/settings"] });
		await router.load();
		cleanups.push(staleBuildTanStack(router, { build: "v1" }));

		await router.navigate({ to: "/settings" });
		server.build = "v2";
		const poll = await fetch("/_serverFn/notifications");

		expect(poll.status).toBe(200);
		expect(loaded).toStrictEqual(["/dashboard", "/settings"]);
		expect(requests).toStrictEqual([
			"http://localhost:3000/_serverFn/settings",
			"http://localhost:3000/_serverFn/notifications",
		]);
		expect(documentLoads).toStrictEqual([]);
	});

	it("reloads the target when a later request of a navigation comes from a new build, and the old code never gets it", async () => {
		const { server, documentLoads } = page({ serverBuild: "v1" });
		const { router, loaded } = tanstack({ "/settings": ["/_serverFn/user", "/_serverFn/keys"] });
		await router.load();
		const send = fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input, init) => {
				const response = await send(input, init);
				server.build = "v2";
				return response;
			}),
		);
		cleanups.push(staleBuildTanStack(router, { build: "v1" }));

		const navigation = router.navigate({ to: "/settings" });

		await expect(settles(navigation)).resolves.toBe(false);
		expect(loaded).toStrictEqual(["/dashboard"]);
		expect(documentLoads).toStrictEqual(["reload http://localhost:3000/settings"]);
	});

	it("gives a request outside a navigation its response, and reloads at the next navigation with no request", async () => {
		const { requests, documentLoads } = page({ serverBuild: "v2" });
		const { router, loaded } = tanstack({ "/settings": ["/_serverFn/settings"] });
		await router.load();
		cleanups.push(staleBuildTanStack(router, { build: "v1" }));

		const poll = await fetch("/_serverFn/notifications");
		const navigation = router.navigate({ to: "/settings" });

		expect(poll.status).toBe(200);
		await expect(settles(navigation)).resolves.toBe(false);
		expect(loaded).toStrictEqual(["/dashboard"]);
		expect(requests).toStrictEqual(["http://localhost:3000/_serverFn/notifications"]);
		expect(documentLoads).toStrictEqual(["reload http://localhost:3000/settings"]);
	});

	it("lets a blocker cancel a navigation, and never reloads the page after a new build", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { router } = tanstack();
		await router.load();
		cleanups.push(staleBuildTanStack(router, { build: "v1" }));
		const unblock = router.history.block({ blockerFn: () => true });

		const navigation = router.navigate({ to: "/settings" });
		const poll = await fetch("/_serverFn/notifications");
		unblock();

		await expect(settles(navigation)).resolves.toBe(false);
		expect(poll.status).toBe(200);
		expect(location.pathname).toBe("/dashboard");
		expect(documentLoads).toStrictEqual([]);
	});

	it("reloads at a history step after a new build, also to a page with no data request", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { router } = tanstack();
		await router.load();
		await router.navigate({ to: "/usage" });
		cleanups.push(staleBuildTanStack(router, { build: "v1" }));
		await fetch("/_serverFn/notifications");

		router.history.back();
		await vi.waitFor(() => {
			expect(documentLoads).toStrictEqual(["reload http://localhost:3000/dashboard"]);
		});
	});

	it("tries again at the next navigation when the visitor stays on the page at a leave prompt", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { router } = tanstack();
		await router.load();
		cleanups.push(staleBuildTanStack(router, { build: "v1" }));
		await fetch("/_serverFn/notifications");

		void router.navigate({ to: "/settings" });
		void router.navigate({ to: "/usage" });

		await vi.waitFor(() => {
			expect(documentLoads).toStrictEqual([
				"reload http://localhost:3000/settings",
				"reload http://localhost:3000/usage",
			]);
		});
	});

	it("keeps a change to the fragment in the page after a new build", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { router } = tanstack();
		await router.load();
		cleanups.push(staleBuildTanStack(router, { build: "v1" }));
		await fetch("/_serverFn/notifications");

		await router.navigate({ to: "/dashboard", hash: "usage" });

		expect(documentLoads).toStrictEqual([]);
	});

	it("never reloads for the late response of a navigation that a newer one replaced", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { router } = tanstack({ "/settings": ["/_serverFn/settings"] });
		await router.load();
		const answer = Promise.withResolvers<Response>();
		const server = fetch;
		const slow = vi.fn<typeof fetch>(async () => answer.promise);
		vi.stubGlobal("fetch", slow);
		cleanups.push(staleBuildTanStack(router, { build: "v1" }));

		void router.navigate({ to: "/settings" });
		await vi.waitFor(() => {
			expect(slow).toHaveBeenCalledTimes(1);
		});
		await router.navigate({ to: "/usage" });
		answer.resolve(await server("/_serverFn/settings"));
		await settles(Promise.resolve());

		expect(documentLoads).toStrictEqual([]);
	});

	it("reloads when a navigation takes the pending loader of a preload, and the old code never gets it", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { router, loaded } = tanstack({ "/settings": ["/_serverFn/settings"] });
		await router.load();
		const answer = Promise.withResolvers<Response>();
		const server = fetch;
		const slow = vi.fn<typeof fetch>(async () => answer.promise);
		vi.stubGlobal("fetch", slow);
		cleanups.push(staleBuildTanStack(router, { build: "v1" }));

		// Why the cast: the test router has no registered route types.
		void router.preloadRoute({ to: "/settings" } as Parameters<typeof router.preloadRoute>[0]);
		await vi.waitFor(() => {
			expect(slow).toHaveBeenCalledTimes(1);
		});
		const navigation = router.navigate({ to: "/settings" });
		answer.resolve(await server("/_serverFn/settings"));

		await expect(settles(navigation)).resolves.toBe(false);
		expect(slow).toHaveBeenCalledTimes(1);
		expect(loaded).toStrictEqual(["/dashboard"]);
		expect(documentLoads).toStrictEqual(["reload http://localhost:3000/settings"]);
	});

	it("reloads when the data of a navigation comes from a proxy route of a new build", async () => {
		const { documentLoads } = page({ serverBuild: "v1" });
		const { router, loaded } = tanstack({ "/settings": ["/api/keys"] });
		await router.load();
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(
				async () =>
					new Response("data", {
						headers: { "Server-Timing": String.raw`db;dur=5, build;desc="v\"2"` },
					}),
			),
		);
		const onNewBuild = vi.fn<(served: string) => void>();
		cleanups.push(staleBuildTanStack(router, { build: "v1", onNewBuild }));

		const navigation = router.navigate({ to: "/settings" });

		await expect(settles(navigation)).resolves.toBe(false);
		expect(loaded).toStrictEqual(["/dashboard"]);
		expect(onNewBuild).toHaveBeenCalledExactlyOnceWith('v"2');
		expect(documentLoads).toStrictEqual(["reload http://localhost:3000/settings"]);
	});

	it("never renders the data of a preload from a new build while the target loads as a document", async () => {
		const { server, documentLoads } = page({ serverBuild: "v1" });
		const { router, loaded } = tanstack({ "/settings": ["/_serverFn/settings"] });
		await router.load();
		cleanups.push(staleBuildTanStack(router, { build: "v1" }));
		server.build = "v2";

		// Why the cast: the test router has no registered route types.
		await router.preloadRoute({ to: "/settings" } as Parameters<typeof router.preloadRoute>[0]);
		const navigation = router.navigate({ to: "/settings" });

		await expect(settles(navigation)).resolves.toBe(false);
		expect(loaded).toStrictEqual(["/dashboard", "/settings"]);
		expect(router.state.resolvedLocation?.pathname).toBe("/dashboard");
		expect(documentLoads).toStrictEqual(["reload http://localhost:3000/settings"]);
	});

	it("never reloads for a navigation that a change to the fragment replaced", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { router } = tanstack({ "/settings": ["/_serverFn/settings"] });
		await router.load();
		const answer = Promise.withResolvers<Response>();
		const server = fetch;
		const slow = vi.fn<typeof fetch>(async () => answer.promise);
		vi.stubGlobal("fetch", slow);
		cleanups.push(staleBuildTanStack(router, { build: "v1" }));

		void router.navigate({ to: "/settings" });
		await vi.waitFor(() => {
			expect(slow).toHaveBeenCalledTimes(1);
		});
		void router.navigate({ to: "/dashboard", hash: "section" });
		answer.resolve(await server("/_serverFn/settings"));
		await settles(Promise.resolve());

		expect(documentLoads).toStrictEqual([]);
	});

	it("returns the response of a POST from a new build in a navigation", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { router } = tanstack();
		await router.load();
		cleanups.push(staleBuildTanStack(router, { build: "v1" }));
		let save: Promise<Response> | undefined;
		cleanups.push(
			router.subscribe("onBeforeLoad", () => {
				save = fetch("/_serverFn/save", { method: "POST" });
			}),
		);

		await router.navigate({ to: "/settings" });

		await expect(save).resolves.toHaveProperty("status", 200);
		expect(documentLoads).toStrictEqual([]);
	});

	it("gives back `fetch` when it stops, and does nothing with no build", async () => {
		page({ serverBuild: "v2" });
		const { router } = tanstack();
		const server = fetch;
		vi.spyOn(performance, "getEntriesByType").mockReturnValueOnce([]);

		staleBuildTanStack(router)();
		const stopped = staleBuildTanStack(router, { build: "v1" });
		const patched = fetch;
		stopped();

		expect(patched).not.toBe(server);
		expect(fetch).toBe(server);
	});

	it("keeps a later `fetch` wrapper when it stops, and then passes each request on", async () => {
		const { documentLoads } = page({ serverBuild: "v2" });
		const { router } = tanstack();
		await router.load();
		const stop = staleBuildTanStack(router, { build: "v1" });
		const patched = fetch;
		const wrapper = vi.fn<typeof fetch>(async (input, init) => patched(input, init));
		vi.stubGlobal("fetch", wrapper);

		void router.navigate({ to: "/settings" });
		stop();
		const response = await fetch("/_serverFn/settings");

		expect(fetch).toBe(wrapper);
		expect(response.status).toBe(200);
		expect(documentLoads).toStrictEqual([]);
	});
});
