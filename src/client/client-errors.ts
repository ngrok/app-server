import { CLIENT_ERRORS_PATH } from "../core/client-error-report.js";
import type { ClientErrorReport, ClientErrorSource } from "../core/client-error-report.js";
import { timingBuild } from "./stale-build-navigation.js";

/** Options for {@link clientErrorsReactRouter} and {@link clientErrorsTanStack}. */
export type ClientErrorsReporterOptions = {
	/**
	 * The path of the endpoint: the `path` of `clientErrors()`.
	 * @default "/_app/issues"
	 */
	path?: string;
};

/** The options of `hydrateRoot` that report the errors of a React root. */
export type ClientErrorsRootOptions = {
	onUncaughtError: (error: unknown) => void;
	onCaughtError: (error: unknown) => void;
	onRecoverableError: (error: unknown) => void;
};

/** The hooks that {@link clientErrorsReactRouter} gives to React and React Router. */
export type ClientErrorsReactRouter = {
	/** Give it to `HydratedRouter` as `onError`. */
	onError: (error: unknown, info: { pattern: string }) => void;
	/** Give it to `hydrateRoot` as its options. */
	rootOptions: ClientErrorsRootOptions;
};

/** The global of {@link clientErrorsScript}: the events that it kept, and its listener. */
const BUFFER = "__appServerErrors";

/** What {@link clientErrorsScript} puts in the {@link BUFFER} global. */
type EventBuffer = { events: Event[]; keep: (event: Event) => void };

/** The events that the reporter listens for on `window`. */
const EVENTS = ["error", "unhandledrejection"] as const;

/** Why 10: one broken page can throw in a loop, and the first errors show the cause. */
const MAX_REPORTS = 10;

/**
 * The text of an inline script that keeps the `error` and
 * `unhandledrejection` events of the page until the client module loads.
 * Without it, the app gets no report of an error that comes before the entry
 * chunk runs, such as a chunk that throws while it loads.
 *
 * Render it in the `<head>` of the document, before the framework's scripts,
 * with the CSP nonce. A prerendered page needs no nonce: the `appServer`
 * Vite plugin records the hash of the script.
 *
 * @example
 * <script nonce={cspNonce()} dangerouslySetInnerHTML={{ __html: clientErrorsScript }} />
 */
export const clientErrorsScript = `(function(w,b){b=w.${BUFFER}={events:[]};b.keep=function(e){b.events.push(e)};${EVENTS.map((type) => `w.addEventListener("${type}",b.keep)`).join(";")}})(window)`;

/**
 * Starts the reporter of a page: it listens on `window`, takes the events of
 * {@link clientErrorsScript}, and gives the function that reports one error.
 */
function startReporter({ path = CLIENT_ERRORS_PATH }: ClientErrorsReporterOptions) {
	const sent = new Set<string>();
	const report = (thrown: unknown, source: ClientErrorSource, route?: string): void => {
		if (!(thrown instanceof Error) || thrown.stack == null || sent.size >= MAX_REPORTS) {
			return;
		}
		const { name, message, stack } = thrown;
		// Why the first URL: it is the frame that threw. A browser extension and a script of another
		// origin give another origin, and an error with no stack, such as `Script error.`, gives none.
		// Why remove the message: Chromium starts the stack with it, and it can hold a URL.
		const thrownAt = /[a-z-]+:\/\/[^\s)]+/iu.exec(stack.replace(message, ""))?.[0];
		const key = `${message}\n${stack}`;
		if (thrownAt?.startsWith(`${location.origin}/`) !== true || sent.has(key)) {
			return;
		}
		sent.add(key);
		const body: ClientErrorReport = {
			name,
			message: message.slice(0, 1000),
			stack: stack.slice(0, 10_000),
			source,
			path: location.pathname,
			route,
			build: timingBuild(performance.getEntriesByType("navigation")),
		};
		// Why `keepalive`: the report goes out when the page unloads. Why `omit`: the report needs no
		// cookie, so the server gets no session with it.
		void fetch(path, {
			method: "POST",
			keepalive: true,
			credentials: "omit",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}).catch(() => undefined);
	};
	const onEvent = (event: Event): void => {
		const thrown: unknown = "reason" in event ? event.reason : Reflect.get(event, "error");
		report(thrown, event.type === "error" ? "error" : "unhandledrejection");
	};
	// oxlint-disable-next-line typescript/no-unsafe-assignment -- only `clientErrorsScript` sets this global, and a global type would reach each app.
	const buffer: EventBuffer | undefined = Reflect.get(globalThis, BUFFER);
	for (const type of EVENTS) {
		addEventListener(type, onEvent);
		if (buffer != null) {
			removeEventListener(type, buffer.keep);
		}
	}
	for (const event of buffer?.events.splice(0) ?? []) {
		onEvent(event);
	}
	return report;
}

/** The root options that report with `report`, and then do what React does with no option. */
function rootOptionsOf(report: ReturnType<typeof startReporter>): ClientErrorsRootOptions {
	return {
		onUncaughtError: (error) => {
			report(error, "uncaught");
			reportError(error);
		},
		onCaughtError: (error) => {
			// Why a microtask: React Router reports the render error of a route after this hook, with the
			// route pattern, and the first report of an error wins.
			queueMicrotask(() => {
				report(error, "caught");
			});
			// oxlint-disable-next-line no-console -- React logs a caught error when the root has no `onCaughtError`.
			console.error(error);
		},
		onRecoverableError: (error) => {
			report(error, "recoverable");
			reportError(error);
		},
	};
}

/**
 * Reports the errors of a React Router app's client code to the endpoint of
 * `clientErrors()`. Call it once, in the client entry.
 *
 * - It reports the `error` and `unhandledrejection` events of the page, the
 *   errors of the React root, and the errors that the router gets from a
 *   loader, an action, or a route render, with the route pattern.
 * - It keeps an error only when the frame that threw is a script of the
 *   page's origin. So it drops the errors of a browser extension and of a
 *   third-party script, and each thrown value that is not an `Error`.
 * - It sends each error once, and 10 reports at most for each page load.
 * - It sets no cookie, reads no storage, and sends no user identifier. A
 *   report has the name, the message, and the stack of the error, the
 *   pathname of the page, the route pattern, and the build.
 *
 * @example
 * // app/entry.client.tsx
 * const clientErrors = clientErrorsReactRouter();
 *
 * startTransition(() => {
 * 	hydrateRoot(document, <HydratedRouter onError={clientErrors.onError} />, clientErrors.rootOptions);
 * });
 */
export function clientErrorsReactRouter(
	options: ClientErrorsReporterOptions = {},
): ClientErrorsReactRouter {
	const report = startReporter(options);
	return {
		onError: (error, { pattern }) => {
			report(error, "router", pattern);
		},
		rootOptions: rootOptionsOf(report),
	};
}

/**
 * Reports the errors of a TanStack Start app's client code to the endpoint
 * of `clientErrors()`, as {@link clientErrorsReactRouter} does. Call it
 * once, in the client entry. The router throws the error of a loader in the
 * render of its route, so the React root gets it.
 *
 * @example
 * // src/client.tsx
 * const clientErrors = clientErrorsTanStack();
 *
 * startTransition(() => {
 * 	hydrateRoot(document, <StartClient />, clientErrors.rootOptions);
 * });
 */
export function clientErrorsTanStack(options: ClientErrorsReporterOptions = {}): {
	rootOptions: ClientErrorsRootOptions;
} {
	return { rootOptions: rootOptionsOf(startReporter(options)) };
}
