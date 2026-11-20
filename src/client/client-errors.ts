import { clientErrorsPath, MAX_REPORT_BYTES } from "../core/client-error-report.js";
import type { ClientErrorReport, ClientErrorSource } from "../core/client-error-report.js";
import { timingBuild } from "./stale-build-navigation.js";

/**
 * The options of `hydrateRoot` that report the errors of a React root.
 * `onUncaughtError` and `onCaughtError` need React 19. React 18 ignores them.
 */
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
 * Why 100: a page whose entry chunk never runs can throw in a loop, and the
 * script must not keep each event. The reporter sends {@link MAX_REPORTS} at
 * most, and it drops the events of other origins first.
 */
const MAX_KEPT = 100;

/** The least of a long message that a report keeps when its body is too large. */
const MIN_MESSAGE = 100;

/**
 * The text of an inline script that keeps the `error` and
 * `unhandledrejection` events of the page until the client module loads.
 * Without it, the app gets no report of an error that comes before the entry
 * chunk runs, such as a chunk that throws while it loads.
 *
 * The script keeps 100 events at most. If the client module does not take
 * them, such as when an import of the entry chunk throws, the script sends
 * the first 10 itself when the page hides. Those reports have no route and
 * no build, and the script does not check the origin of an error.
 *
 * Render it in the `<head>` of the document, before the framework's scripts,
 * with the CSP nonce. A prerendered page needs no nonce: the `appServer`
 * Vite plugin records the hash of the script.
 *
 * @example
 * <script nonce={cspNonce()} dangerouslySetInnerHTML={{ __html: clientErrorsScript() }} />
 */
export function clientErrorsScript(): string {
	// Why `\u003c`: a path with `</script>` must not end the inline script.
	const url = JSON.stringify(clientErrorsPath()).replaceAll("<", String.raw`\u003c`);
	// Why 500 and 4,000 characters: the report stays below the limit of the endpoint.
	const send = `function(e){var x=e.reason||e.error;x&&x.stack&&fetch(${url},{method:"POST",keepalive:!0,credentials:"omit",body:JSON.stringify({name:x.name,message:(""+x.message).slice(0,500),stack:x.stack.slice(0,4e3),source:e.type,path:location.pathname})}).catch(function(){})}`;
	const listen = EVENTS.map((type) => `w.addEventListener("${type}",b.keep)`).join(";");
	return `(function(w,b){b=w.${BUFFER}={events:[]};b.keep=function(e){b.events.length<${MAX_KEPT}&&b.events.push(e)};${listen};w.addEventListener("pagehide",function(){b.events.splice(0).slice(0,${MAX_REPORTS}).forEach(${send})})})(window)`;
}

/**
 * Starts the reporter of a page: it listens on `window`, takes the events of
 * {@link clientErrorsScript}, and gives the function that reports one error.
 */
function startReporter() {
	const path = clientErrorsPath();
	const sent = new Set<string>();
	const report = (thrown: unknown, source: ClientErrorSource, route?: string): void => {
		if (!(thrown instanceof Error) || thrown.stack == null || sent.size >= MAX_REPORTS) {
			return;
		}
		const { name, message, stack } = thrown;
		// Why only the frame lines: Chromium starts the stack with the name and the message, and the
		// message can hold a URL and can be long. Its frames start with `at`. Firefox and Safari give
		// only frames, and each ends with a line and a column.
		const lines = stack.split("\n");
		const atLines = lines.filter((line) => line.startsWith("    at "));
		const frames = (
			atLines.length > 0 ? atLines : lines.filter((line) => /:\d+:\d+$/u.test(line))
		).join("\n");
		// Why the first URL: it is the frame that threw. A browser extension and a script of another
		// origin give another origin, and an error with no stack, such as `Script error.`, gives none.
		const thrownAt = /[a-z-]+:\/\/[^\s)]+/iu.exec(frames)?.[0];
		const key = `${message}\n${stack}`;
		if (thrownAt?.startsWith(`${location.origin}/`) !== true || sent.has(key)) {
			return;
		}
		sent.add(key);
		const body: ClientErrorReport = {
			name,
			message: message.slice(0, 1000),
			stack: frames.slice(0, MAX_REPORT_BYTES),
			source,
			path: location.pathname,
			route,
			build: timingBuild(performance.getEntriesByType("navigation")),
		};
		// Why bytes: the endpoint limits the bytes of the body, and one character can be 6 bytes
		// of JSON. Why the message first, and then the last frames: the first frame shows the cause.
		const encoder = new TextEncoder();
		let json = JSON.stringify(body);
		while (encoder.encode(json).length > MAX_REPORT_BYTES) {
			const lastFrame = body.stack.lastIndexOf("\n");
			if (body.message.length > MIN_MESSAGE) {
				body.message = body.message.slice(0, Math.max(MIN_MESSAGE, body.message.length / 2));
			} else if (lastFrame === -1) {
				return;
			} else {
				body.stack = body.stack.slice(0, lastFrame);
			}
			json = JSON.stringify(body);
		}
		// Why `keepalive`: the report goes out when the page unloads. Why `omit`: the report needs no
		// cookie, so the server gets no session with it.
		void fetch(path, {
			method: "POST",
			keepalive: true,
			credentials: "omit",
			headers: { "Content-Type": "application/json" },
			body: json,
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
export function clientErrorsReactRouter(): ClientErrorsReactRouter {
	const report = startReporter();
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
export function clientErrorsTanStack(): { rootOptions: ClientErrorsRootOptions } {
	return { rootOptions: rootOptionsOf(startReporter()) };
}
