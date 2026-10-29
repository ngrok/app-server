import { createServer, type Server } from "node:net";

const MAX_PORT = 65_535;

/** Options for {@link listenFromPort}. */
export type ListenFromPortOptions = {
	/** The first port to try. 0 lets the OS pick one. */
	port: number;
	/** @default every interface */
	hostname?: string;
	/** When true, a port in use throws and no other port is tried. */
	strictPort: boolean;
	/** Runs for each port in use before the next port is tried. */
	onPortInUse?: (port: number) => void;
	/**
	 * Runs when `strictPort` is true and the server listens on `hostname`, but
	 * another server holds the port on a wildcard address.
	 */
	onWildcardInUse?: (port: number) => void;
};

/**
 * Starts `server` on `port`. When the port is in use, it tries each next port
 * up to 65535, like Vite and `react-router-serve` do in development.
 *
 * @returns the port that the server listens on
 */
export async function listenFromPort(
	server: Server,
	{ port, hostname, strictPort, onPortInUse, onWildcardInUse }: ListenFromPortOptions,
): Promise<number> {
	if (port === 0) {
		await bind(server, port, hostname);
		return boundPort(server, port);
	}
	if (strictPort) {
		// Why a warning and not an error: a server on one other address also fails the wildcard
		// check, and that server does not share `hostname`. Vite warns for the same reason.
		const freeOnWildcard = hostname == null || (await isFreeOnWildcard(port));
		await bind(server, port, hostname);
		if (!freeOnWildcard) {
			onWildcardInUse?.(port);
		}
		return port;
	}
	for (let candidate = port; candidate <= MAX_PORT; candidate++) {
		// Why the wildcard check: a server on `::` and a server on `localhost` can share a port, and
		// then the browser can reach the other server.
		if (hostname == null || (await isFreeOnWildcard(candidate))) {
			try {
				await bind(server, candidate, hostname);
				return candidate;
			} catch (error) {
				if (!isAddressInUse(error)) {
					throw error;
				}
			}
		}
		onPortInUse?.(candidate);
	}
	throw new Error(`No open port from ${port} to ${MAX_PORT}.`);
}

function bind(server: Server, port: number, hostname: string | undefined): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, hostname);
	});
}

async function isFreeOnWildcard(port: number): Promise<boolean> {
	const probe = createServer();
	try {
		await bind(probe, port, undefined);
	} catch (error) {
		if (isAddressInUse(error)) {
			return false;
		}
		throw error;
	}
	await new Promise<void>((resolve) => {
		probe.close(() => {
			resolve();
		});
	});
	return true;
}

function boundPort(server: Server, fallback: number): number {
	const address = server.address();
	return typeof address === "object" && address != null ? address.port : fallback;
}

function isAddressInUse(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
