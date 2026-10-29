/** What every runtime listener takes. */
export type ListenOptions = {
	port: number;
	/** The interface to bind. When omitted, the listener binds every interface. */
	hostname: string | undefined;
	/** How long an idle keep-alive connection stays open. */
	idleTimeoutMs: number;
};

/**
 * The URL a listener answers on. A wildcard bind reads as `localhost`.
 *
 * @example
 * listenerUrl("0.0.0.0", 3000); // => "http://localhost:3000/"
 * listenerUrl("::1", 3000); // => "http://[::1]:3000/"
 */
export function listenerUrl(hostname: string | undefined, port: number): string {
	if (hostname == null || hostname === "" || hostname === "0.0.0.0" || hostname === "::") {
		return `http://localhost:${port}/`;
	}
	return hostname.includes(":") ? `http://[${hostname}]:${port}/` : `http://${hostname}:${port}/`;
}
