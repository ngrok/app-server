import { networkInterfaces } from "node:os";
import { styleText } from "node:util";
import { listenerUrl } from "../node/runtimes/listen-options.js";

const wildcardHosts = new Set(["", "0.0.0.0", "::"]);
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

type DevUrl = { local: boolean; url: string; interfaceName: string | undefined };

/**
 * The lines that `app-server start` prints when it listens, in the format of `vite dev`. A wildcard
 * host gets one line for each IPv4 interface.
 *
 * @example
 * devUrlLines("localhost", 3000); // => ["  ➜  Local:   http://localhost:3000/"]
 */
export function devUrlLines(
	hostname: string | undefined,
	port: number,
	interfaces = networkInterfaces(),
): string[] {
	const addresses = Object.entries(interfaces).flatMap(([name, details = []]) =>
		details.map(({ address, family }) => ({ name, address, family })),
	);
	const urls: DevUrl[] =
		hostname == null || wildcardHosts.has(hostname)
			? addresses
					.filter(({ family }) => family === "IPv4")
					.map(({ name, address }) => {
						const local = address === "127.0.0.1";
						return {
							local,
							url: listenerUrl(local ? "localhost" : address, port),
							interfaceName: name,
						};
					})
			: [
					{
						local: loopbackHosts.has(hostname),
						url: listenerUrl(hostname, port),
						interfaceName: addresses.find(({ address }) => address === hostname)?.name,
					},
				];
	const width = Math.max(0, ...urls.filter(({ local }) => !local).map(({ url }) => url.length));
	return urls
		.toSorted((a, b) => Number(b.local) - Number(a.local))
		.map(({ local, url, interfaceName }) => {
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
