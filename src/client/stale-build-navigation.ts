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
};

/**
 * How long a click or a history step stays the target of the router's next
 * data request. Why a limit: an app can cancel a click without a
 * navigation, and a later data request must not go to that link.
 */
const PENDING_MS = 10_000;

/** The build in the `Server-Timing` of the document's navigation entry. */
function documentBuild(): string | undefined {
	return performance
		.getEntriesByType("navigation")
		.filter((entry): entry is PerformanceNavigationTiming => "serverTiming" in entry)
		.flatMap((entry) => entry.serverTiming)
		.find((metric) => metric.name === BUILD_ID_METRIC)?.description;
}

/** Loads `url` as a new document. */
function loadDocument(url: string): void {
	location.assign(url);
}

/**
 * The URL that a click opens as a new document, or `undefined` when the click
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
	const here = new URL(location.href);
	if (url.origin !== here.origin) {
		return undefined;
	}
	const samePage = url.pathname === here.pathname && url.search === here.search;
	return samePage && url.hash !== "" ? undefined : url.href;
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
 * It reads the build of each data response that the router fetches. When the
 * server runs a new build:
 *
 * - If the visitor started the navigation (a link click or a history step),
 *   the browser loads the target URL as a document. The old code never sees
 *   the new data.
 * - Each later link click, history step, and `history.pushState` loads the
 *   target URL as a document, so the visitor gets the new build at the next
 *   page change.
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
	build = documentBuild(),
}: StaleBuildNavigationOptions = {}): () => void {
	if (build == null) {
		return () => {};
	}
	const listening = new AbortController();
	const { signal } = listening;
	let stale = false;
	let pending: { url: string; at: number } | undefined;

	addEventListener(
		"click",
		(event) => {
			const url = followedLink(event);
			if (url == null) {
				return;
			}
			if (stale) {
				// Why stop it: the router's click handler never runs, so the browser follows the link as a document load.
				event.stopImmediatePropagation();
				return;
			}
			pending = { url, at: Date.now() };
		},
		{ capture: true, signal },
	);

	addEventListener(
		"popstate",
		(event) => {
			if (stale) {
				event.stopImmediatePropagation();
				loadDocument(location.href);
				return;
			}
			pending = { url: location.href, at: Date.now() };
		},
		{ signal },
	);

	const pushState = history.pushState.bind(history);
	const replaceState = history.replaceState.bind(history);
	const send = globalThis.fetch;
	history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
		pending = undefined;
		if (stale && url != null) {
			loadDocument(new URL(url, location.href).href);
			return;
		}
		pushState(data, unused, url);
	};
	history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
		pending = undefined;
		replaceState(data, unused, url);
	};

	globalThis.fetch = async (input, init) => {
		const response = await send.call(globalThis, input, init);
		const served = response.headers.get(header);
		if (served == null || served === build) {
			return response;
		}
		stale = true;
		const target =
			pending != null && Date.now() - pending.at < PENDING_MS ? pending.url : undefined;
		if (target == null || methodOf(input, init) !== "GET") {
			return response;
		}
		await response.body?.cancel();
		loadDocument(target);
		// Why a promise that never settles: the page unloads, and the old code must not render the new build's data.
		return new Promise<Response>(() => {});
	};
	return () => {
		listening.abort();
		history.pushState = pushState;
		history.replaceState = replaceState;
		globalThis.fetch = send;
	};
}
