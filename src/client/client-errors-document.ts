import { CLIENT_ERRORS_GLOBAL } from "../core/client-error-report.js";
import type { ClientErrorsGlobal } from "../core/client-error-report.js";

/**
 * The text of the inline script that the document has. Why not the text that
 * the server makes: the browser needs no copy of the reporter, and React
 * finds no change when it hydrates the script.
 *
 * @example
 * <script nonce={cspNonce()} dangerouslySetInnerHTML={{ __html: documentClientErrorsScript() }} />
 */
export function documentClientErrorsScript(): string {
	// oxlint-disable-next-line typescript/no-unsafe-assignment -- only the inline script sets this global, and a global type would reach each app.
	const page: ClientErrorsGlobal | undefined = Reflect.get(globalThis, CLIENT_ERRORS_GLOBAL);
	return page?.text ?? "";
}
