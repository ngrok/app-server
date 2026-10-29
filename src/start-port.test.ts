import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { listenFromPort } from "./start-port.js";

const servers: Server[] = [];

function server(): Server {
	const created = createServer();
	servers.push(created);
	return created;
}

async function occupiedPort(hostname?: string): Promise<number> {
	const taken = server();
	await new Promise<void>((resolve) => {
		taken.listen(0, hostname, resolve);
	});
	const address = taken.address();
	if (typeof address !== "object" || address == null) {
		throw new Error("The server has no port.");
	}
	return address.port;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(open) =>
				new Promise<void>((resolve) => {
					open.close(() => {
						resolve();
					});
				}),
		),
	);
});

describe("listenFromPort", () => {
	it("moves to the next port when the port is in use", async () => {
		const taken = await occupiedPort();
		const inUse: number[] = [];

		const port = await listenFromPort(server(), {
			port: taken,
			strictPort: false,
			onPortInUse: (skipped) => inUse.push(skipped),
		});

		expect(port).toBeGreaterThan(taken);
		expect(inUse[0]).toBe(taken);
	});

	it("skips a port that a wildcard server holds when it binds to localhost", async () => {
		const taken = await occupiedPort();

		const port = await listenFromPort(server(), {
			port: taken,
			hostname: "localhost",
			strictPort: false,
		});

		expect(port).toBeGreaterThan(taken);
	});

	it("throws when the port is in use and strictPort is true", async () => {
		const taken = await occupiedPort();

		await expect(listenFromPort(server(), { port: taken, strictPort: true })).rejects.toThrow(
			/EADDRINUSE/,
		);
	});

	it("warns when strictPort is true and a wildcard server holds the port", async () => {
		const taken = await occupiedPort();
		const shared: number[] = [];

		// Why both outcomes: macOS lets `127.0.0.1` share a port with a wildcard server, and Linux
		// does not.
		const outcome = await listenFromPort(server(), {
			port: taken,
			hostname: "127.0.0.1",
			strictPort: true,
			onWildcardInUse: (port) => shared.push(port),
		}).catch((error: unknown) => error);

		const result =
			outcome instanceof Error
				? { refused: outcome.message.includes("EADDRINUSE") }
				: { port: outcome, shared };
		expect([{ refused: true }, { port: taken, shared: [taken] }]).toContainEqual(result);
	});

	it("returns the port that the OS picks for port 0", async () => {
		const port = await listenFromPort(server(), { port: 0, strictPort: false });

		expect(port).toBeGreaterThan(0);
	});
});
