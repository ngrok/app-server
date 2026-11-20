import { CLIENT_ERRORS_GLOBAL } from "../core/client-error-report.js";
import type { ClientErrorsGlobal } from "../core/client-error-report.js";

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

/**
 * The function of the inline script that reports one error. Why an error line
 * with no script: the app then sends no report, and nothing else shows it.
 */
function pageReport(): ClientErrorsGlobal["report"] {
	// oxlint-disable-next-line typescript/no-unsafe-assignment -- only the inline script sets this global, and a global type would reach each app.
	const page: ClientErrorsGlobal | undefined = Reflect.get(globalThis, CLIENT_ERRORS_GLOBAL);
	if (page == null) {
		// oxlint-disable-next-line no-console -- the app developer must see that no report goes out.
		console.error(
			"@ngrok/app-server: the page has no client error script, so the app sends no client error report. Render clientErrorsScript() in the <head> of the document, and turn on clientErrors in the server.",
		);
		return () => {
			// The page has no reporter.
		};
	}
	return page.report;
}

/** The root options that report with `report`, and then do what React does with no option. */
function rootOptionsOf(report: ClientErrorsGlobal["report"]): ClientErrorsRootOptions {
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
 * Gives the errors that React and React Router catch in a React Router app
 * to the inline script of `clientErrorsScript()`, which sends each report to
 * the endpoint of `clientErrors()`. Call it once, in the client entry.
 *
 * - The hooks report the errors of the React root, and the errors that the
 *   router gets from a loader, an action, or a route render, with the route
 *   pattern. The inline script reports the `error` and `unhandledrejection`
 *   events of the page.
 * - The script keeps an error only when the frame that threw is a script of
 *   the page's origin. So it drops the errors of a browser extension and of
 *   a third-party script, and each thrown value that is not an `Error`.
 * - It sends each error once, and 10 reports at most for each page load.
 * - It sets no cookie, reads no storage, and sends no user identifier. A
 *   report has the name, the message, and the stack of the error, the
 *   pathname of the page, the route pattern, and the build.
 * - With no inline script in the page, it logs one error line, and the app
 *   sends no report.
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
	const report = pageReport();
	return {
		onError: (error, { pattern }) => {
			// Why the `/`: React Router gives `domains/:domainId`, and the `http.route` of the access log
			// has `/domains/:domainId`. An error with no route has an empty pattern.
			const route = pattern === "" || pattern.startsWith("/") ? pattern : `/${pattern}`;
			report(error, "router", route === "" ? undefined : route);
		},
		rootOptions: rootOptionsOf(report),
	};
}

/**
 * Gives the errors that React catches in a TanStack Start app to the inline
 * script of `clientErrorsScript()`, as {@link clientErrorsReactRouter} does. Call it
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
	return { rootOptions: rootOptionsOf(pageReport()) };
}
