import { networkInterfaces } from "node:os";
import { styleText } from "node:util";
import type { ResolvedServerUrls } from "vite";
import { listenerUrl } from "../node/runtimes/listen-options.js";

const wildcardHosts = new Set(["", "0.0.0.0", "::"]);
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The URLs that `app-server start` listens on, in the shape of Vite's `server.resolvedUrls`. Each
 * URL ends with `base`, Vite's base path. A wildcard host gets a `localhost` URL, then one URL for
 * each IPv4 (Internet Protocol version 4) interface.
 *
 * @example
 * devUrls({ hostname: "localhost", port: 3000, base: "/" });
 * // => { local: ["http://localhost:3000/"], network: [], networkInterfaceNames: [] }
 */
export function devUrls(
	{ hostname, port, base }: { hostname: string | undefined; port: number; base: string },
	interfaces = networkInterfaces(),
): Required<ResolvedServerUrls> {
	const urlOf = (host: string) => `${listenerUrl(host, port).slice(0, -1)}${base}`;
	const addresses = Object.entries(interfaces).flatMap(([name, details = []]) =>
		details.map(({ address, family }) => ({ name, address, family })),
	);
	if (hostname != null && !wildcardHosts.has(hostname)) {
		return loopbackHosts.has(hostname)
			? { local: [urlOf(hostname)], network: [], networkInterfaceNames: [] }
			: {
					local: [],
					network: [urlOf(hostname)],
					networkInterfaceNames: [addresses.find(({ address }) => address === hostname)?.name],
				};
	}
	const reachable = addresses.filter(
		({ address, family }) => family === "IPv4" && address !== "127.0.0.1",
	);
	return {
		// Why a `localhost` URL with no lookup: a host with no IPv4 loopback still gets a URL to open.
		local: [urlOf("localhost")],
		network: reachable.map(({ address }) => urlOf(address)),
		networkInterfaceNames: reachable.map(({ name }) => name),
	};
}

/** `url` in the colors of `vite dev`, which makes the port bold. */
function link(url: string): string {
	return styleText("cyan", url.replace(/:(?<port>\d+)\//u, `:${styleText("bold", "$<port>")}/`));
}

/**
 * The lines that `app-server start` prints for `urls` when it listens, in the format of `vite dev`.
 *
 * @example
 * devUrlLines({ local: ["http://localhost:3000/"], network: [] }); // => ["  ➜  Local:   http://localhost:3000/"]
 */
export function devUrlLines({
	local,
	network,
	networkInterfaceNames = [],
}: ResolvedServerUrls): string[] {
	const arrow = styleText("green", "➜");
	const width = Math.max(0, ...network.map((url) => url.length));
	return [
		...local.map((url) => `  ${arrow}  ${styleText("bold", "Local")}:   ${link(url)}`),
		...network.map((url, index) => {
			const name = networkInterfaceNames[index];
			const suffix =
				name == null ? "" : " ".repeat(width - url.length + 2) + styleText("dim", name);
			return `  ${arrow}  ${styleText("bold", "Network")}: ${link(url)}${suffix}`;
		}),
	];
}
