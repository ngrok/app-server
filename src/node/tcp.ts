import type { Listener } from "../core/types.js";

/** Above the ngrok edge's 90 s idle pool, so the edge never reuses a socket that the server is closing. */
const DEFAULT_IDLE_TIMEOUT_MS = 95_000;

/**
 * The largest `idleTimeoutMs`. Why 1 s under the limit of a timer: Node.js
 * adds 1 s to the value for the timer of each socket.
 */
const MAX_IDLE_TIMEOUT_MS = 2_147_483_647 - 1_000;

/** Options for {@link tcp}. */
export type TcpOptions = {
	/**
	 * A port here wins over `PORT` and over the `--port` of `app-server serve`,
	 * with no message. Leave it out to let the operator choose.
	 * @default the `PORT` environment variable, else 3000
	 */
	port?: number;
	/**
	 * A host here wins over `HOST`.
	 * @default the `HOST` environment variable, else every interface
	 */
	host?: string;
	/**
	 * How long an idle keep-alive connection stays open, in milliseconds. Set
	 * it above the idle time of the proxy in front of the server, so the proxy
	 * never sends a request on a connection that the server closes.
	 *
	 * - Node.js keeps an idle connection for this time.
	 * - Bun counts whole seconds, 255 at most. It also closes a response that
	 *   sends no bytes for this time.
	 * - Deno has no idle timeout, so the option has no effect there.
	 *
	 * @default 95000, above the 90 s idle pool of the ngrok edge
	 */
	idleTimeoutMs?: number;
};

/**
 * Reads a port number. A value that is not an integer from 0 to 65535 throws,
 * so a bad `PORT` stops startup.
 *
 * @example
 * parsePort("8080"); // => 8080
 */
export function parsePort(value: string): number {
	const port = Number(value);
	if (value.trim() === "" || !Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`PORT must be an integer from 0 to 65535, not "${value}".`);
	}
	return port;
}

/**
 * The default listener: a TCP port, served by the runtime's own HTTP server
 * (`node:http` on Node, `Bun.serve` on Bun, `Deno.serve` on Deno). It reads
 * `PORT` and `HOST` when it starts, unless the options give a port or a host.
 * An `idleTimeoutMs` that is not an integer from 0 to 2147482647 throws, so a
 * bad value stops startup.
 *
 * @example
 * createServer({ listeners: [tcp({ idleTimeoutMs: 120_000 })] });
 */
export function tcp({
	port,
	host,
	idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
}: TcpOptions = {}): Listener {
	if (
		!Number.isInteger(idleTimeoutMs) ||
		idleTimeoutMs < 0 ||
		idleTimeoutMs > MAX_IDLE_TIMEOUT_MS
	) {
		throw new Error(
			`idleTimeoutMs must be an integer from 0 to ${MAX_IDLE_TIMEOUT_MS}, not ${idleTimeoutMs}.`,
		);
	}
	return {
		name: "tcp",
		start: async (fetch, { trustForwardedProto = false } = {}) => {
			const options = {
				port: port ?? (process.env.PORT == null ? 3000 : parsePort(process.env.PORT)),
				hostname: host ?? (process.env.HOST || undefined),
				idleTimeoutMs,
				trustForwardedProto,
			};
			if ("Bun" in globalThis) {
				return (await import("./runtimes/bun.js")).listen(fetch, options);
			}
			if ("Deno" in globalThis) {
				return (await import("./runtimes/deno.js")).listen(fetch, options);
			}
			return (await import("./runtimes/node.js")).listen(fetch, options);
		},
	};
}
