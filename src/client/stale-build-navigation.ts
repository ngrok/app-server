import { BUILD_ID_HEADER, BUILD_ID_METRIC } from "../core/plugins/build-id.js";

/** Options for {@link staleBuildNavigation}. */
export type StaleBuildNavigationOptions = {
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

/**
 * How long a link click, a history step, or a history update stays the
 * target of the data requests that start after it. Why a limit: an app can
 * cancel a click with no navigation, and a later data request must not go to
 * that link.
 */
const PENDING_MS = 10_000;

/** A navigation that the router started, and the data requests that it claims. */
type Navigation = { url: string; at: number; answered: boolean };

/** Whether `url` is on the origin of this page. */
function isOwn(url: string): boolean {
	return new URL(url, location.href).origin === location.origin;
}

/** The build in the `Server-Timing` of the first of `entries` that has one, from this origin only. */
function timingBuild(entries: PerformanceEntryList): string | undefined {
	return entries
		.filter(
			(entry): entry is PerformanceResourceTiming => "serverTiming" in entry && isOwn(entry.name),
		)
		.flatMap((entry) => entry.serverTiming)
		.find((metric) => metric.name === BUILD_ID_METRIC)?.description;
}

/** The page of `url`: the router renders a new route for a new path or query, not for a new fragment. */
function pageOf(url: string): string {
	const { origin, pathname, search } = new URL(url, location.href);
	return `${origin}${pathname}${search}`;
}

/**
 * The URL that a click opens as a new page, or `undefined` when the click
 * does not leave the page: a modified click, a link to a new window or a
 * download, a link to another origin, or a link to a part of this page.
 */
function followedLink(event: MouseEvent): string | undefined {
	if (
		event.defaultPrevented ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey ||
		!(event.target instanceof Element)
	) {
		return undefined;
	}
	const anchor = event.target.closest("a[href]");
	if (
		!(anchor instanceof HTMLAnchorElement) ||
		(anchor.target !== "" && anchor.target !== "_self") ||
		anchor.hasAttribute("download")
	) {
		return undefined;
	}
	const url = new URL(anchor.href, location.href);
	if (url.origin !== location.origin) {
		return undefined;
	}
	return pageOf(url.href) === pageOf(location.href) && url.hash !== "" ? undefined : url.href;
}

/** The URL of a `fetch` call. */
function urlOf(input: RequestInfo | URL): string {
	return input instanceof Request ? input.url : String(input);
}

/** The method of a `fetch` call. */
function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
	return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

/**
 * Moves an open tab to a new build at a navigation, so the old client code
 * never renders data from the new server, and the page that the visitor
 * reads never reloads.
 *
 * It reads the build of each data response that the router fetches, and of
 * each response from this origin that the browser makes, such as a
 * prefetch. When the server runs a new build:
 *
 * - If a navigation (a link click, a history step, or a history update to a
 *   new page) started the data request, the browser loads the target URL as
 *   a document. The old code never sees the new data.
 * - After that, each `history.pushState` and `history.replaceState` to a new
 *   page loads the target URL as a document, so the visitor gets the new
 *   build at the next page change.
 * - The app's click handlers and the router's blockers still run first.
 *
 * It sends no request of its own. It needs `buildId()` in the server's
 * pipeline, and it does nothing on a document with no build. Call it before
 * the router starts, so its listeners run first. It returns a function that
 * removes its listeners and gives back `fetch` and `history`.
 *
 * @example
 * // app/entry.client.tsx
 * staleBuildNavigation();
 * startTransition(() => {
 * 	hydrateRoot(document, <HydratedRouter />);
 * });
 */
export function staleBuildNavigation({
	header = BUILD_ID_HEADER,
	build = timingBuild(performance.getEntriesByType("navigation")),
	onNewBuild,
}: StaleBuildNavigationOptions = {}): () => void {
	if (build == null) {
		return () => {};
	}
	const listening = new AbortController();
	const { signal } = listening;
	let stale = false;
	let navigation: Navigation | undefined;
	let page = pageOf(location.href);
	const see = (served: string | null | undefined) => {
		if (served == null || served === build || stale) {
			return;
		}
		stale = true;
		onNewBuild?.(served);
	};
	const start = (url: string) => {
		navigation = { url, at: Date.now(), answered: false };
	};
	// Why resource timing: it shows the build of a response that no script fetched, such as a
	// prefetch on hover, so the tab can find a new build before the click. Why buffered: a prefetch
	// can finish before this module runs.
	const observer =
		typeof PerformanceObserver === "function"
			? new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						see(timingBuild([entry]));
					}
				})
			: undefined;
	observer?.observe({ type: "resource", buffered: true });

	// Why no stop after a new build: the app's handlers and the router's blockers must run first.
	// The router then fetches data or updates history, and those calls load the document.
	addEventListener(
		"click",
		(event) => {
			const url = followedLink(event);
			if (url != null) {
				start(url);
			}
		},
		{ capture: true, signal },
	);

	addEventListener(
		"popstate",
		() => {
			const before = page;
			page = pageOf(location.href);
			if (page !== before) {
				start(location.href);
			}
		},
		{ signal },
	);

	const pushState = history.pushState.bind(history);
	const replaceState = history.replaceState.bind(history);
	const send = globalThis.fetch;
	const update =
		(native: typeof history.pushState, load: (url: string) => void) =>
		(data: unknown, unused: string, url?: string | URL | null) => {
			const target = url == null ? undefined : new URL(url, location.href);
			// Why the native call for another origin: it throws the `SecurityError` that the app expects.
			if (target == null || target.origin !== location.origin || pageOf(target.href) === page) {
				native(data, unused, url);
				return;
			}
			if (stale) {
				load(target.href);
				return;
			}
			if (navigation?.url !== target.href) {
				start(target.href);
			} else if (navigation.answered) {
				// Why: a router that updates history after its data request ends that navigation here.
				navigation = undefined;
			}
			native(data, unused, url);
			page = pageOf(location.href);
		};
	history.pushState = update(pushState, (url) => {
		location.assign(url);
	});
	history.replaceState = update(replaceState, (url) => {
		location.replace(url);
	});

	globalThis.fetch = async (input, init) => {
		// Why at the start: a slow data request still belongs to the navigation that started it.
		const claimed =
			navigation != null && !navigation.answered && Date.now() - navigation.at < PENDING_MS
				? navigation
				: undefined;
		const response = await send.call(globalThis, input, init);
		// Why the final URL: a redirect can end on another origin.
		const url = response.url === "" ? urlOf(input) : response.url;
		const served = isOwn(url) ? response.headers.get(header) : null;
		if (served == null) {
			return response;
		}
		if (claimed != null) {
			claimed.answered = true;
		}
		see(served);
		// Why the current navigation only: a late response of a navigation that a newer one replaced
		// must not move the visitor away from the page that they read.
		if (
			served === build ||
			claimed == null ||
			claimed !== navigation ||
			methodOf(input, init) !== "GET"
		) {
			return response;
		}
		// Why no wait: the cancel of a cloned body waits for the other branch.
		response.body?.cancel().catch(() => undefined);
		location.assign(claimed.url);
		// Why a promise that never settles: the page unloads, and the old code must not render the new build's data.
		return new Promise<Response>(() => {});
	};
	return () => {
		listening.abort();
		observer?.disconnect();
		history.pushState = pushState;
		history.replaceState = replaceState;
		globalThis.fetch = send;
	};
}
