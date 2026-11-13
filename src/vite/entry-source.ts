import type { FrameworkBuild, HostBuild } from "./index.js";

/** The module ID of the server entry that `appServer` generates. */
export const SERVER_ENTRY_ID = "virtual:@ngrok/app-server/entry";
export const RESOLVED_SERVER_ENTRY_ID = `\0${SERVER_ENTRY_ID}`;

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
		...(appModule == null
			? [
					`const app = createServer({ trustForwardedProto: process.env.TRUST_FORWARDED_PROTO === "1", trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? 0) });`,
				]
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
