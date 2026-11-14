import type { CreateServerOptions } from "../core/create-server.js";
import type { FrameworkBuild, HostBuild } from "./index.js";

/** The module ID of the server entry that `appServer` generates. */
export const SERVER_ENTRY_ID = "virtual:@ngrok/app-server/entry";
/** What the plugin resolves {@link SERVER_ENTRY_ID} to. Why `\0`: no other plugin then loads or transforms the ID as a file. */
export const RESOLVED_SERVER_ENTRY_ID = `\0${SERVER_ENTRY_ID}`;

/**
 * The `createServer` options that the environment gives the default app: the
 * app of a build with no `server.ts`. `TRUST_FORWARDED_PROTO` is `1` or `0`,
 * and `TRUSTED_PROXY_HOPS` is an integer of 0 or more. No value and an empty
 * value keep the default. Each other value throws, so it stops startup.
 *
 * Why no binding from outside its body: {@link serverEntrySource} writes the
 * source of this function into the server entry, so the entry and the CLI
 * share one parser.
 *
 * @example
 * environmentOptions({ TRUST_FORWARDED_PROTO: "1", TRUSTED_PROXY_HOPS: "2" });
 * // => { trustForwardedProto: true, trustedProxyHops: 2 }
 */
export function environmentOptions(
	env: Readonly<Record<string, string | undefined>>,
): Pick<CreateServerOptions, "trustForwardedProto" | "trustedProxyHops"> {
	const proto = env.TRUST_FORWARDED_PROTO ?? "";
	// Why `JSON.stringify` in each message: it shows a character that a terminal hides, such as the
	// `\r` of a CRLF env file.
	if (proto !== "" && proto !== "0" && proto !== "1") {
		throw new Error(
			`TRUST_FORWARDED_PROTO must be "1" or "0", not ${JSON.stringify(proto)}. Set TRUST_FORWARDED_PROTO=1 to trust X-Forwarded-Proto, or remove the variable.`,
		);
	}
	const hops = env.TRUSTED_PROXY_HOPS ?? "";
	// Why the pattern: `Number` also reads "1e2", "0x10", and a space as a number.
	if (!/^\d*$/u.test(hops) || !Number.isSafeInteger(Number(hops))) {
		throw new Error(
			`TRUSTED_PROXY_HOPS must be an integer of 0 or more, not ${JSON.stringify(hops)}. Set it to the number of proxies in front of the server, such as TRUSTED_PROXY_HOPS=1, or remove the variable.`,
		);
	}
	return { trustForwardedProto: proto === "1", trustedProxyHops: Number(hops) };
}

/** What {@link serverEntrySource} needs. */
type EntrySource = {
	framework: Pick<FrameworkBuild, "serverModule" | "runtimeModule" | "runtimeOptions">;
	host: Pick<HostBuild, "runtimeModule">;
	/** The absolute path of the app module, else `undefined` for the default app. */
	appModule: string | undefined;
	/** The source of an expression that gives the client build: a path or a `file:` URL. */
	clientDirectory: string;
};

/**
 * The source of the server entry. When a runtime runs the file as its main
 * module, such as `node build/server/app-server.js`, the entry starts the
 * server. When the CLI imports it, the CLI starts the server.
 *
 * @example
 * serverEntrySource({ framework: reactRouterAdapter(), host: node(), appModule: "/app/server.ts", clientDirectory: '"/app/build/client"' });
 */
export function serverEntrySource({
	framework,
	host,
	appModule,
	clientDirectory,
}: EntrySource): string {
	const modules = [
		framework.serverModule,
		// Why from the bundle: the CLI calls this export, so the server runs on the bundle's copy of
		// this package and of the framework, the same copies as the app and the routes.
		"@ngrok/app-server",
		framework.runtimeModule,
		host.runtimeModule,
		...(appModule == null ? [] : [appModule]),
	];
	return [
		// Why before the imports: React reads `NODE_ENV` when it loads. Why dynamic imports: a static
		// import loads before this line.
		"if (import.meta.main) {",
		'\tprocess.env.NODE_ENV ??= "production";',
		'\tif (typeof process.setSourceMapsEnabled === "function") {',
		"\t\tprocess.setSourceMapsEnabled(true);",
		"\t}",
		"}",
		`const [serverModule, { createEntry, createServer }, { runtime }, hostModule${appModule == null ? "" : ", { default: app }"}] = await Promise.all([`,
		...modules.map((module) => `\timport(${JSON.stringify(module)}),`),
		"]);",
		// Why the source of the function: the entry runs on the bundle's copy of this package, and
		// that copy exports no parser for the environment.
		...(appModule == null
			? [`const app = createServer((${environmentOptions.toString()})(process.env));`]
			: []),
		`export const appServer = createEntry({`,
		`\tapp,`,
		`\thost: hostModule.host,`,
		`\tclientDirectory: ${clientDirectory},`,
		`\tframework: (mode) => runtime(serverModule, { ${framework.runtimeOptions == null ? "" : `...${framework.runtimeOptions}, `}mode }),`,
		`});`,
		// Why: a serverless host's function file calls the run side through the bundle's copy.
		"export { hostModule };",
		"if (import.meta.main) {",
		"\tawait appServer.start();",
		"}",
	].join("\n");
}
