// Why a module with no import at run time: the browser bundle of `@ngrok/app-server/client`
// imports it, and that bundle must hold no server code.

/**
 * The default path of the endpoint of `clientErrors()`. Why this name: an ad
 * blocker blocks a request whose path has a word such as `error`, `log`, or
 * `report`.
 */
export const CLIENT_ERRORS_PATH = "/_app/issues";

/**
 * The name of the constant that holds the `clientErrorsPath` of the
 * `appServer` Vite plugin. The plugin gives it to Vite as a `define`, so the
 * client build holds the path, and the server entry that the plugin
 * generates sets it as a global, so the server reads the same path.
 */
export const CLIENT_ERRORS_PATH_CONSTANT = "__APP_SERVER_CLIENT_ERRORS_PATH__";

// oxlint-disable-next-line no-underscore-dangle -- the name of a Vite `define` constant, which no name of an app must equal.
declare const __APP_SERVER_CLIENT_ERRORS_PATH__: string | undefined;

/**
 * The path of the endpoint of `clientErrors()`: the `clientErrorsPath` of
 * the `appServer` Vite plugin, else {@link CLIENT_ERRORS_PATH}. Why a
 * function: the server entry sets the global after this module loads.
 */
export function clientErrorsPath(): string {
	return typeof __APP_SERVER_CLIENT_ERRORS_PATH__ === "string"
		? __APP_SERVER_CLIENT_ERRORS_PATH__
		: CLIENT_ERRORS_PATH;
}

/**
 * The largest body of a report, in bytes. The client module sends no more,
 * and the endpoint takes no more. Why 6 KiB: a browser refuses a `keepalive`
 * request when the bodies in flight pass 64 KiB, and a page sends 10 reports
 * at most.
 */
export const MAX_REPORT_BYTES = 6 * 1024;

/** The values of `source` in a {@link ClientErrorReport}. */
export const CLIENT_ERROR_SOURCES = [
	"error",
	"unhandledrejection",
	"uncaught",
	"caught",
	"recoverable",
	"router",
] as const;

/**
 * Where the client got an error:
 *
 * - `error` and `unhandledrejection`: the event of that name on `window`.
 * - `uncaught`, `caught`, and `recoverable`: the React root option
 *   `onUncaughtError`, `onCaughtError`, or `onRecoverableError`.
 * - `router`: the `onError` of the router.
 */
export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];

/** The JSON body that the client module posts to the endpoint of `clientErrors()`. */
export type ClientErrorReport = {
	name: string;
	message: string;
	stack: string;
	source: ClientErrorSource;
	/** The pathname of the page, with no query and no fragment. */
	path: string;
	/** The route pattern, when the router gave one. */
	route?: string | undefined;
	/** The build that the document runs, when `buildId()` sent one. */
	build?: string | undefined;
};
