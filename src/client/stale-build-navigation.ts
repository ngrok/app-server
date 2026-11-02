import {
	BUILD_ID_HEADER,
	BUILD_ID_METRIC,
	isBuildMetric,
	serverTimingMetrics,
} from "../core/plugins/build-id.js";

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
	clearCache: () => void;
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

/** The build in a `Server-Timing` header, as `buildId()` writes it. */
function headerBuild(header: string | null): string | undefined {
	const { quoted, token } =
		serverTimingMetrics(header)
			.find((metric) => isBuildMetric(metric))
			?.match(/;\s*desc\s*=\s*(?:"(?<quoted>(?:[^"\\]|\\.)*)"|(?<token>[^;\s]*))/iu)?.groups ?? {};
	return quoted?.replaceAll(/\\(?<char>.)/gu, "$<char>") ?? token;
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
			// Why the final URL: a redirect can end on another origin. Why `Server-Timing`: a proxy
			// route of `buildId({ paths })` sends no build header.
			const served = isOwn(response.url === "" ? url : response.url)
				? (response.headers.get(header) ?? headerBuild(response.headers.get("Server-Timing")))
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
};

/**
 * The arguments of a client middleware call. Why the `unstable_` fields: React
 * Router gives the middleware the arguments of its data strategy, which tell a
 * navigation from a fetcher and give its history action.
 */
type MiddlewareArgs = {
	request: Request;
	unstable_initiator?: string;
	unstable_navigationType?: string | null;
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
	/**
	 * The path of the last action of a navigation, until its loaders run. The
	 * router revalidates the page with one or more loader requests after it.
	 */
	let action: string | undefined;
	/** The target that the tab loads as a document now. */
	let leaving: string | undefined;
	/**
	 * The last `navigate` call. `claimed` is true when its first middleware call
	 * already ran, or when it is not a page load.
	 */
	let navigating: { hash: string; claimed: boolean } | undefined;
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
			const isAfterAction = request.method === "GET" && action === path;
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
						action = undefined;
						await handler();
						// Why keep an unclaimed call: a blocker stops it, and `blocker.proceed()` starts it
						// again with no `navigate` call.
						if (navigating === current && current.claimed) {
							navigating = undefined;
						}
					},
				});
			},
		},
		middleware: async (args, next) => {
			const {
				request,
				unstable_initiator: initiator,
				unstable_navigationType: navigationType,
			} = args as MiddlewareArgs;
			if (initiator === "navigation") {
				// Why here: a `clientAction` sends no request, and the router runs the middleware once
				// for an action and once for all the loaders after it.
				const path = new URL(request.url).pathname;
				if (navigationType === "POP") {
					action = undefined;
				} else if (request.method !== "GET") {
					action = path;
					onAbort(request.signal, () => {
						if (action === path) {
							action = undefined;
						}
					});
					return next();
				} else if (action === path) {
					try {
						return await next();
					} finally {
						action = undefined;
					}
				}
			}
			const current = navigating;
			// Why no history step: it comes from no `navigate` call, and the fetch hook reloads it.
			// Why the first call only: the router runs the middleware of a navigation before the
			// fetchers that it revalidates, and they have the same initiator.
			if (
				initiator !== "navigation" ||
				navigationType == null ||
				navigationType === "POP" ||
				current == null ||
				current.claimed
			) {
				return next();
			}
			current.claimed = true;
			if (
				request.signal.aborted ||
				watch()?.isStale() !== true ||
				pageOf(request.url) === pageOf(location.href)
			) {
				return next();
			}
			return load(request, request.url + current.hash, { navigationType });
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
 *   query clears the router cache and loads the page as a document.
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
				// Why clear: the router matches the target after this event, and a preload can hold the
				// new build's data. With no cache, each loader fetches again, and `fetch` holds it.
				router.clearCache();
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
