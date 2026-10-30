import { BUILD_ID_HEADER, BUILD_ID_METRIC } from "../core/plugins/build-id.js";

/** Options for {@link staleBuildReactRouter} and {@link staleBuildTanStack}. */
export type StaleBuildOptions = {
	/**
	 * The header that `buildId()` sets on data responses.
	 * @default "X-Build-Id"
	 */
	header?: string;
	/**
	 * The build that this document runs. Set it only when the server does not
	 * send it.
	 * @default the `build` metric of the document's `Server-Timing`, which `buildId()` sends
	 */
	build?: string;
	/**
	 * Runs once, when the tab first sees a response from another build. Use
	 * it to count stale tabs in the app's RUM tool.
	 */
	onNewBuild?: (served: string) => void;
};

/** The context that React Router gives `unstable_fetch` with each request. */
export type RouterFetchContext = {
	/** `"navigation"` for the data request of a navigation that the router started. */
	type: string;
	/** `"PUSH"`, `"REPLACE"`, or `"POP"` for a navigation. */
	navigationType?: string | null;
	/** The fetcher that sends the request, also in a navigation that revalidates it. */
	fetcherKey?: string | null;
};

/** The location in a TanStack Router event. */
type EventLocation = { pathname: string; searchStr: string };

/** The part of a TanStack Router that {@link staleBuildTanStack} reads. */
export type NavigationEvents = {
	history: { flush: () => void };
	subscribe: (
		type: "onBeforeNavigate" | "onResolved",
		listener: (event: { fromLocation?: EventLocation; toLocation: EventLocation }) => void,
	) => () => void;
};

/** Whether `url` is on the origin of this page. */
function isOwn(url: string): boolean {
	return new URL(url, location.href).origin === location.origin;
}

/** The build in the `Server-Timing` of the first of `entries` that has one, from this origin only. */
function timingBuild(entries: PerformanceEntryList): string | undefined {
	return (
		entries
			.filter(
				(entry): entry is PerformanceResourceTiming => "serverTiming" in entry && isOwn(entry.name),
			)
			// Why: a redirected resource keeps its first URL as its name, and the redirect can end on
			// another origin. A document entry has its final URL.
			.filter((entry) => entry.entryType !== "resource" || entry.redirectStart === 0)
			.flatMap((entry) => entry.serverTiming)
			.find((metric) => metric.name === BUILD_ID_METRIC)?.description
	);
}

/** The page of `url`: the router renders a new route for a new path or query, not for a new fragment. */
function pageOf(url: string): string {
	const { origin, pathname, search } = new URL(url, location.href);
	return `${origin}${pathname}${search}`;
}

/** The page of a TanStack Router location, as {@link pageOf} reads a URL. */
function eventPage({ pathname, searchStr }: EventLocation): string {
	return `${pathname}${searchStr}`;
}

/** The URL of a `fetch` call. */
function urlOf(input: RequestInfo | URL): string {
	return input instanceof Request ? input.url : String(input);
}

/** The method of a `fetch` call. */
function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
	return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

/** The page that a React Router data request loads: `/a.data` loads `/a`, and `/a/_.data` loads `/a/`. */
function targetOf(request: Request): string {
	const url = new URL(request.url);
	url.pathname = url.pathname.replace(/\/_\.data$/u, "/").replace(/\.data$/u, "");
	url.searchParams.delete("_routes");
	return url.href;
}

/**
 * Loads `target` as a document, so the old code never gets the new build's
 * data. It returns a promise that never settles, because the page unloads.
 */
async function loadDocument(
	target: string,
	{
		response,
		navigationType,
	}: { response?: Response | undefined; navigationType?: string | null | undefined } = {},
): Promise<never> {
	// Why no wait: the cancel of a cloned body waits for the other branch.
	response?.body?.cancel().catch(() => undefined);
	// Why reload on this page: the router can move history first, and `assign` to the same page
	// with a fragment scrolls with no document load. A history step already moved history.
	if (navigationType === "POP" || pageOf(target) === pageOf(location.href)) {
		location.reload();
	} else if (navigationType === "REPLACE") {
		location.replace(target);
	} else {
		location.assign(target);
	}
	return new Promise<never>(() => {});
}

/**
 * Runs `clear` when `signal` aborts. Why: the router aborts a navigation when a
 * newer one starts, such as after the visitor stays on the page at a leave prompt.
 */
function onAbort(signal: AbortSignal, clear: () => void): void {
	signal.addEventListener("abort", clear, { once: true });
}

/** Reads the build of each response, and tells when the server runs a new build. */
function watchBuild({ header = BUILD_ID_HEADER, build, onNewBuild }: StaleBuildOptions) {
	const current = build ?? timingBuild(performance.getEntriesByType("navigation"));
	if (current == null) {
		return null;
	}
	let stale = false;
	const see = (served: string | null | undefined) => {
		if (served == null || served === current || stale) {
			return;
		}
		stale = true;
		onNewBuild?.(served);
	};
	// Why resource timing: it shows the build of a response that no script fetched, such as a
	// prefetch on hover, so the tab can find a new build before the click. Why buffered: a prefetch
	// can finish before this module runs.
	const observer =
		typeof PerformanceObserver === "function"
			? new PerformanceObserver((list) => {
					// Why each entry: one delivery can hold the old build first and the new build after it.
					for (const entry of list.getEntries()) {
						see(timingBuild([entry]));
					}
				})
			: undefined;
	observer?.observe({ type: "resource", buffered: true });
	return {
		isStale: () => stale,
		/** Whether `response` comes from a new build of this origin. `url` is the URL of the request. */
		isNew: (response: Response, url: string) => {
			// Why the final URL: a redirect can end on another origin.
			const served = isOwn(response.url === "" ? url : response.url)
				? response.headers.get(header)
				: null;
			see(served);
			return served != null && served !== current;
		},
		stop: () => observer?.disconnect(),
	};
}

/** The `navigate` call of a React Router instrumentation. */
type NavigateInfo = { to: string | number; formMethod?: string };

/** The router instrumentations that {@link staleBuildReactRouter} adds. */
type RouterInstrumentations = {
	navigate: (handler: () => Promise<unknown>, info: NavigateInfo) => Promise<void>;
	fetch: (handler: () => Promise<unknown>) => Promise<void>;
};

/** The hooks that {@link staleBuildReactRouter} gives to React Router. */
export type StaleBuildReactRouter = {
	/** Give it to `HydratedRouter` as `unstable_fetch`. */
	fetch: (request: Request, context: RouterFetchContext) => Promise<Response>;
	/** Give it to `HydratedRouter` in `instrumentations`. */
	instrumentation: {
		router: (router: { instrument: (instrumentations: RouterInstrumentations) => void }) => void;
	};
	/** Export it from `app/root.tsx` in `clientMiddleware`. */
	middleware: <Result>(args: { request: Request }, next: () => Promise<Result>) => Promise<Result>;
};

/** The fragment of a `navigate` target, such as `#usage`, or `""`. */
function hashOf(to: string | number): string {
	return typeof to === "string" && to.includes("#") ? to.slice(to.indexOf("#")) : "";
}

/**
 * Moves an open React Router tab to a new build at a navigation, so the old
 * client code never renders data from the new server, and the page that the
 * visitor reads never reloads. Create it in a module that the client entry
 * and `app/root.tsx` both import. It reads no browser state until React
 * Router calls it, so the server can import it.
 *
 * - When the data request of a navigation gets a response from a new build,
 *   the browser loads the target URL as a document.
 * - When the tab already knows of a new build, a `navigate` call, such as a
 *   link click, loads its target as a document before the router renders it
 *   or sends a data request. The root middleware does this also for a route
 *   with no loader.
 * - A revalidation, a fetcher, an action, and the loaders after an action
 *   get their response. They only mark the tab, so the page that the visitor
 *   reads never reloads.
 * - The router's blockers run first, and a canceled navigation never loads
 *   its target.
 *
 * It sends no request of its own and adds no wait. It needs `buildId()` in
 * the server's pipeline, and it does nothing on a document with no build.
 *
 * @example
 * // app/stale-build.ts
 * export const staleBuild = staleBuildReactRouter();
 *
 * // app/root.tsx
 * export const clientMiddleware = [staleBuild.middleware];
 *
 * // app/entry.client.tsx
 * startTransition(() => {
 * 	hydrateRoot(
 * 		document,
 * 		<HydratedRouter
 * 			unstable_fetch={staleBuild.fetch}
 * 			instrumentations={[staleBuild.instrumentation]}
 * 		/>,
 * 	);
 * });
 */
export function staleBuildReactRouter(options: StaleBuildOptions = {}): StaleBuildReactRouter {
	// Why lazy: `app/root.tsx` also runs on the server, which has no tab to watch.
	let watched: { watch: ReturnType<typeof watchBuild> } | undefined;
	const watch = () => {
		watched ??= { watch: watchBuild(options) };
		return watched.watch;
	};
	/** The path of the last action. The router revalidates the page with the loaders after it. */
	let action: string | undefined;
	/** The target that the tab loads as a document now. */
	let leaving: string | undefined;
	/**
	 * The `navigate` call that runs now. `claimed` is true when its first
	 * middleware call already ran, or when it is not a page load.
	 */
	let navigating: { hash: string; claimed: boolean } | undefined;
	/** The number of fetcher calls that run now. */
	let fetchers = 0;
	const load = async (
		request: Request,
		target: string,
		{ response, navigationType }: { response?: Response; navigationType?: string | null } = {},
	) => {
		if (leaving === target) {
			void response?.body?.cancel().catch(() => undefined);
			return new Promise<never>(() => {});
		}
		leaving = target;
		onAbort(request.signal, () => {
			if (leaving === target) {
				leaving = undefined;
			}
		});
		return loadDocument(target, { response, navigationType });
	};
	return {
		fetch: async (request, context) => {
			const navigationType =
				context.type === "navigation" && context.fetcherKey == null
					? context.navigationType
					: undefined;
			// Why the global at each call: an app can wrap `fetch` after this module, such as for RUM.
			const send = async () => {
				const response = await globalThis.fetch(request);
				return { response, isNew: watch()?.isNew(response, request.url) === true };
			};
			if (watch() == null || navigationType == null) {
				return (await send()).response;
			}
			// Why the hash of the `navigate` call: the router removes it from the data request.
			const target = targetOf(request) + (navigationType === "POP" ? "" : (navigating?.hash ?? ""));
			const path = new URL(target).pathname;
			const isAfterAction = action === path;
			action = request.method === "GET" ? undefined : path;
			onAbort(request.signal, () => {
				if (action === path) {
					action = undefined;
				}
			});
			// Why check the signal: a canceled navigation must never load its target.
			const isNavigation = () =>
				request.method === "GET" && !isAfterAction && !request.signal.aborted;
			if (isNavigation() && watch()?.isStale() === true) {
				return load(request, target, { navigationType });
			}
			const { response, isNew } = await send();
			if (!isNew || !isNavigation()) {
				return response;
			}
			return load(request, target, { response, navigationType });
		},
		instrumentation: {
			router: ({ instrument }) => {
				watch();
				instrument({
					navigate: async (handler, { to, formMethod }) => {
						// Why claimed: a history step and a form submission are not a page load to take over.
						const current = {
							hash: hashOf(to),
							claimed: typeof to === "number" || (formMethod ?? "GET").toUpperCase() !== "GET",
						};
						navigating = current;
						await handler();
						if (navigating === current) {
							navigating = undefined;
						}
					},
					fetch: async (handler) => {
						fetchers += 1;
						await handler();
						fetchers -= 1;
					},
				});
			},
		},
		middleware: async ({ request }, next) => {
			const current = navigating;
			// Why the first call only: the router runs the middleware of a `navigate` call before the
			// fetchers that it revalidates. Why no fetcher: a fetcher call has its own middleware.
			if (current == null || current.claimed || fetchers > 0 || request.signal.aborted) {
				return next();
			}
			current.claimed = true;
			if (watch()?.isStale() !== true || pageOf(request.url) === pageOf(location.href)) {
				return next();
			}
			return load(request, request.url + current.hash);
		},
	};
}

/**
 * Moves an open TanStack Router tab to a new build at a navigation, so the
 * old client code never renders data from the new server, and the page that
 * the visitor reads never reloads. Call it with the router on the client.
 *
 * - A navigation runs from `onBeforeNavigate` to `onResolved`. The router
 *   moves history and runs its blockers before it.
 * - When a GET response from a new build comes back while a navigation
 *   runs, such as from a server function in a loader, the browser loads the
 *   page as a document.
 * - When the tab already knows of a new build, a navigation to a new path or
 *   query loads the page as a document.
 * - A request outside a navigation gets its response, and only marks the tab.
 *
 * It sends no request of its own and adds no wait. It needs `buildId()` in
 * the server's pipeline, and it does nothing on a document with no build.
 * It returns a function that stops it and gives back `fetch`.
 *
 * @example
 * // src/router.tsx
 * export function getRouter() {
 * 	const router = createRouter({ routeTree });
 * 	if (!router.isServer) {
 * 		staleBuildTanStack(router);
 * 	}
 * 	return router;
 * }
 */
export function staleBuildTanStack(
	router: NavigationEvents,
	options: StaleBuildOptions = {},
): () => void {
	const watch = watchBuild(options);
	if (watch == null) {
		return () => {};
	}
	/** The navigation that runs now. `leaving` is true when it already loads its page as a document. */
	let navigation: { leaving: boolean } | undefined;
	const reload = async (current: { leaving: boolean }, response?: Response) => {
		if (current.leaving) {
			void response?.body?.cancel().catch(() => undefined);
			return new Promise<Response>(() => {});
		}
		current.leaving = true;
		// Why flush: the router's history moves the browser's URL in a microtask, after
		// `onBeforeNavigate`. A reload before that loads the page that the visitor leaves.
		router.history.flush();
		return loadDocument(location.href, { response });
	};
	const unsubscribe = [
		router.subscribe("onBeforeNavigate", ({ fromLocation, toLocation }) => {
			// Why clear first: a change to the fragment replaces a navigation that has not ended.
			navigation = undefined;
			if (fromLocation == null || eventPage(fromLocation) === eventPage(toLocation)) {
				return;
			}
			navigation = { leaving: false };
			if (watch.isStale()) {
				void reload(navigation);
			}
		}),
		router.subscribe("onResolved", () => {
			navigation = undefined;
		}),
	];
	const send = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const isGet = methodOf(input, init) === "GET";
		if (isGet && navigation != null && watch.isStale()) {
			return reload(navigation);
		}
		const response = await send.call(globalThis, input, init);
		// Why the navigation at the response: a navigation can take the pending loader of a preload,
		// or of the navigation that it replaced.
		if (!watch.isNew(response, urlOf(input)) || !isGet || navigation == null) {
			return response;
		}
		return reload(navigation, response);
	};
	return () => {
		for (const stop of unsubscribe) {
			stop();
		}
		watch.stop();
		globalThis.fetch = send;
	};
}
