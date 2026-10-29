import type { Listener } from "./types.js";

/** Above the ngrok edge's 90 s idle pool, so the edge never reuses a socket that the server is closing. */
const DEFAULT_IDLE_TIMEOUT_MS = 95_000;

/** Options for {@link tcp}. */
export type TcpOptions = {
	/** @default the `PORT` environment variable, else 3000 */
	port?: number;
	/** @default the `HOST` environment variable, else every interface */
	host?: string;
	/** @default 95000 */
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
 * `PORT` and `HOST` when it starts.
 *
 * @example
 * createServer({ listeners: [tcp({ port: 8080 })] });
 */
export function tcp({
	port,
	host,
	idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
}: TcpOptions = {}): Listener {
	return {
		name: "tcp",
		start: async (fetch) => {
			const options = {
				port: port ?? (process.env.PORT == null ? 3000 : parsePort(process.env.PORT)),
				hostname: host ?? (process.env.HOST || undefined),
				idleTimeoutMs,
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
