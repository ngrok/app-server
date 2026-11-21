import {
	CLIENT_ERRORS_GLOBAL,
	clientErrorsPath,
	MAX_REPORT_BYTES,
} from "../core/client-error-report.js";
import type { ClientErrorsGlobal } from "../core/client-error-report.js";
import { BUILD_ID_METRIC } from "../core/plugins/build-id.js";

/** Why 10: one broken page can throw in a loop, and the first errors show the cause. */
const MAX_REPORTS = 10;

/** What {@link pageReporter} gets from the server. */
type PageReporterOptions = {
	/** The name of the global that holds the reporter. */
	global: string;
	/** The path of the endpoint. */
	path: string;
	/** The largest body of a report, in bytes. */
	maxBytes: number;
	/** How many reports a page load sends at most. */
	maxReports: number;
	/** The name of the `Server-Timing` metric that holds the build. */
	buildMetric: string;
};

/**
 * The reporter of a page. It listens for the `error` and `unhandledrejection`
 * events of `window`, sends each report, and puts the function that reports
 * one error in a global, for the hooks of the client module.
 *
 * It runs in the page as an inline script: {@link clientErrorsScriptOf}
 * makes the script from the text of this function. So it must use no name of
 * this module, no `<` before a `/` or a `!`, and no comment: a comment is
 * bytes in each document. The reasons for its code:
 *
 * - It keeps only the frame lines of the stack. Chromium starts the stack
 *   with the name and the message, and the message can hold a URL, a line
 *   that looks like a frame, and many bytes. So it removes them first. The
 *   frames of Chromium start with `at`. Firefox and Safari give only frames,
 *   and each ends with a line and a column.
 * - It reads the first URL of the frames: the frame that threw. A browser
 *   extension and a script of another origin give another origin, and an
 *   error with no stack, such as `Script error.`, gives none.
 * - `serverTiming` is optional: an old Safari gives an entry with none.
 * - It limits the bytes of the body, as the endpoint does. One character
 *   can be 6 bytes of JSON. It cuts the message first, and then the last
 *   frames, because the first frame shows the cause.
 * - `keepalive` sends the report when the page unloads. `omit` sends no
 *   cookie, so the server gets no session with the report.
 * - A report that the network drops has no second try.
 * - The warning tells the app developer that the endpoint is off: the
 *   endpoint answers 204 or an error, and a framework answers a path with
 *   no endpoint with a 404, a 405 for a route with no action, or a page.
 */
export function pageReporter({
	global,
	path,
	maxBytes,
	maxReports,
	buildMetric,
}: PageReporterOptions): void {
	const sent = new Set<string>();
	const encoder = new TextEncoder();
	let warned = false;
	const warnOnce = ({ status, ok }: Response): void => {
		if ((status === 404 || status === 405 || (ok && status !== 204)) && !warned) {
			warned = true;
			// oxlint-disable-next-line no-console -- the app developer must see that no report arrives.
			console.warn(
				`@ngrok/app-server: ${path} answered ${status}, so the app gets no client error report. Turn on errors in the server, such as defaultPlugins({ errors: true }).`,
			);
		}
	};
	const report: ClientErrorsGlobal["report"] = (thrown, source, route) => {
		if (!(thrown instanceof Error) || thrown.stack == null || sent.size >= maxReports) {
			return;
		}
		const { name, message, stack } = thrown;
		const header = message ? `${name}: ${message}` : name;
		const lines = (stack.startsWith(header) ? stack.slice(header.length) : stack).split("\n");
		const atLines = lines.filter((line) => line.startsWith("    at "));
		const frames = (
			atLines.length > 0 ? atLines : lines.filter((line) => /:\d+:\d+$/u.test(line))
		).join("\n");
		const thrownAt = /[a-z-]+:\/\/[^\s)]+/iu.exec(frames)?.[0];
		const key = `${message}\n${stack}`;
		if (thrownAt?.startsWith(`${location.origin}/`) !== true || sent.has(key)) {
			return;
		}
		sent.add(key);
		const [navigation]: (PerformanceEntry & {
			serverTiming?: readonly PerformanceServerTiming[];
		})[] = performance.getEntriesByType("navigation");
		const body = {
			name,
			message: message.slice(0, 1000),
			stack: frames.slice(0, maxBytes),
			source,
			path: location.pathname,
			route,
			build: navigation?.serverTiming?.find((metric) => metric.name === buildMetric)?.description,
		};
		let json = JSON.stringify(body);
		while (encoder.encode(json).length > maxBytes) {
			const lastFrame = body.stack.lastIndexOf("\n");
			if (body.message.length > 100) {
				body.message = body.message.slice(0, Math.max(100, body.message.length / 2));
			} else if (lastFrame === -1) {
				return;
			} else {
				body.stack = body.stack.slice(0, lastFrame);
			}
			json = JSON.stringify(body);
		}
		void fetch(path, {
			method: "POST",
			keepalive: true,
			credentials: "omit",
			headers: { "Content-Type": "application/json" },
			body: json,
		}).then(warnOnce, () => undefined);
	};
	const value: ClientErrorsGlobal = { report, text: document.currentScript?.textContent ?? "" };
	Reflect.set(globalThis, global, value);
	addEventListener("error", (event) => {
		report(event.error, "error");
	});
	addEventListener("unhandledrejection", (event) => {
		report(event.reason, "unhandledrejection");
	});
}

/**
 * The text of the inline script that reports to `path`.
 *
 * @example
 * clientErrorsScriptOf("/_app/issues"); // => "(function pageReporter({...}) {...})({...})"
 */
export function clientErrorsScriptOf(path: string): string {
	const options: PageReporterOptions = {
		global: CLIENT_ERRORS_GLOBAL,
		path,
		maxBytes: MAX_REPORT_BYTES,
		maxReports: MAX_REPORTS,
		buildMetric: BUILD_ID_METRIC,
	};
	// Why `\u003c`: a path with `</script>` must not end the inline script.
	const json = JSON.stringify(options).replaceAll("<", String.raw`\u003c`);
	return `(${pageReporter.toString()})(${json})`;
}

/**
 * The text of the inline script that reports the errors of the page's client
 * code to the endpoint of `errors()`. Render it in the `<head>` of the
 * document, before the framework's scripts, with the CSP nonce. A
 * prerendered page needs no nonce: the `appServer` Vite plugin records the
 * hash of the script.
 *
 * The script starts before each chunk of the app, so the app also gets the
 * report of a chunk that throws while it loads. It reports the `error` and
 * `unhandledrejection` events of the page. The hooks of
 * `clientErrorsReactRouter()` and `clientErrorsTanStack()` give it the errors
 * that React and the router catch.
 *
 * On the server, the text has the `clientErrorsPath` of the `appServer` Vite
 * plugin. In the browser, the function gives the text of the script that the
 * document has, so React finds no change when it hydrates.
 *
 * @example
 * <script nonce={cspNonce()} dangerouslySetInnerHTML={{ __html: clientErrorsScript() }} />
 */
export function clientErrorsScript(): string {
	return clientErrorsScriptOf(clientErrorsPath());
}
