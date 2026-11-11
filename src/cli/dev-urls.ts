import { networkInterfaces } from "node:os";
import { styleText } from "node:util";
import { listenerUrl } from "../node/runtimes/listen-options.js";

const wildcardHosts = new Set(["", "0.0.0.0", "::"]);
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

type DevUrl = { local: boolean; url: string; interfaceName: string | undefined };

/**
 * The lines that `app-server start` prints when it listens, in the format of `vite dev`. Each URL
 * ends with `base`, Vite's base path. A wildcard host gets a `localhost` line, then one line for
 * each IPv4 (Internet Protocol version 4) interface.
 *
 * @example
 * devUrlLines({ hostname: "localhost", port: 3000, base: "/" }); // => ["  ➜  Local:   http://localhost:3000/"]
 */
export function devUrlLines(
	{ hostname, port, base }: { hostname: string | undefined; port: number; base: string },
	interfaces = networkInterfaces(),
): string[] {
	const urlOf = (host: string) => `${listenerUrl(host, port).slice(0, -1)}${base}`;
	const addresses = Object.entries(interfaces).flatMap(([name, details = []]) =>
		details.map(({ address, family }) => ({ name, address, family })),
	);
	// Why a `localhost` line with no lookup: a host with no IPv4 loopback still gets a URL to open.
	const urls: DevUrl[] =
		hostname == null || wildcardHosts.has(hostname)
			? [
					{ local: true, url: urlOf("localhost"), interfaceName: undefined },
					...addresses
						.filter(({ address, family }) => family === "IPv4" && address !== "127.0.0.1")
						.map(({ name, address }) => ({
							local: false,
							url: urlOf(address),
							interfaceName: name,
						})),
				]
			: [
					{
						local: loopbackHosts.has(hostname),
						url: urlOf(hostname),
						interfaceName: addresses.find(({ address }) => address === hostname)?.name,
					},
				];
	const width = Math.max(0, ...urls.filter(({ local }) => !local).map(({ url }) => url.length));
	return urls.map(({ local, url, interfaceName }) => {
		const label = styleText("bold", local ? "Local" : "Network") + (local ? ":   " : ": ");
		const link = styleText(
			"cyan",
			url.replace(`:${port}/`, `:${styleText("bold", String(port))}/`),
		);
		const suffix =
			local || interfaceName == null
				? ""
				: " ".repeat(width - url.length + 2) + styleText("dim", interfaceName);
		return `  ${styleText("green", "➜")}  ${label}${link}${suffix}`;
	});
}
