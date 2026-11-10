import { RouterContextProvider } from "react-router";
import type { HandleDocumentRequestFunction, ServerBuild } from "react-router";
import { describe, expect, it } from "vitest";
import { accessLog } from "../core/plugins/access-log.js";
import { requestId } from "../core/plugins/request-id.js";
import { appServerContext, isServerBuild, runtime } from "./index.js";
import { testServer } from "../test-server.js";

/** The module of a route in a server build. */
type RouteModule = NonNullable<ServerBuild["routes"][string]>["module"];

/** A server build with one page, `/whoami`, whose document reads the app server context. */
function documentBuild(overrides: Partial<ServerBuild> = {}): ServerBuild {
	return {
		entry: {
			module: {
				// Why the rest parameter: React Router passes the load context fifth.
				default: (...args: Parameters<HandleDocumentRequestFunction>) => {
					const loadContext = args[4];
					return Response.json({ requestId: loadContext.get(appServerContext).requestId });
				},
			},
		},
		routes: {
			root: { id: "root", path: "", module: { default: () => null } },
			whoami: { id: "whoami", parentId: "root", path: "whoami", module: { default: () => null } },
		},
		assets: {
			entry: { module: "/assets/entry.js", imports: [] },
			routes: {},
			url: "/assets/manifest.js",
			version: "1",
		},
		publicPath: "/",
		assetsBuildDirectory: "build/client",
		future: {},
		ssr: true,
		// oxlint-disable-next-line typescript/no-deprecated -- `ServerBuild` still requires the field.
		isSpaMode: false,
		prerender: ["/whoami"],
		routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
		...overrides,
	};
}

describe("runtime", () => {
	it("passes the request ID to the server render through appServerContext", async () => {
		const framework = runtime(documentBuild(), { mode: "production" });
		const { request } = await testServer({ plugins: [requestId()], render: framework.fetch });

		const response = await request("/whoami", { headers: { "X-Request-Id": "abc-123" } });

		await expect(response.json()).resolves.toStrictEqual({ requestId: "abc-123" });
	});

	it("gives a logger and no request ID outside a server request, as in a prerender pass", () => {
		const context = new RouterContextProvider();

		expect(context.get(appServerContext)).toMatchObject({
			requestId: undefined,
			logger: { info: expect.any(Function) },
		});
	});

	it("logs the route pattern that React Router matched as http.route, and runs the app's middleware", async () => {
		const seen: string[] = [];
		const build = documentBuild();
		build.routes.root = {
			id: "root",
			path: "",
			module: {
				default: () => null,
				middleware: [
					async ({ request }, next) => {
						seen.push(new URL(request.url).pathname);
						return next();
					},
				],
			},
		};
		build.routes.domain = {
			id: "domain",
			parentId: "root",
			path: "domains/:domainId",
			module: { default: () => null },
		};
		build.routes.status = {
			id: "status",
			parentId: "root",
			path: "api/status",
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a resource route has no default export, which the type requires.
			module: { loader: () => Response.json({ ok: true }) } as unknown as RouteModule,
		};
		const framework = runtime(build, { mode: "production" });
		const { request, lines } = await testServer({
			plugins: [accessLog()],
			render: framework.fetch,
		});

		for (const path of [
			"/domains/d_1",
			"/domains/d_1.data",
			"/api/status",
			"/whoami",
			"/nothing/here",
		]) {
			await (await request(path)).text();
		}

		expect(lines.map((line) => line.attributes["http.route"])).toStrictEqual([
			"/domains/:domainId",
			"/domains/:domainId",
			"/api/status",
			"/whoami",
			undefined,
		]);
		expect(seen).toContain("/domains/d_1");
	});

	it("gives the client the build's route manifest, so the route pattern middleware adds no client request", async () => {
		/** A manifest entry for a route with a server loader and no client code. */
		const entry = (id: string, path: string, parentId?: string) => ({
			id,
			path,
			...(parentId == null ? {} : { parentId }),
			module: `/assets/${id}.js`,
			hasAction: false,
			hasLoader: true,
			hasClientAction: false,
			hasClientLoader: false,
			hasClientMiddleware: false,
			hasErrorBoundary: false,
			clientActionModule: undefined,
			clientLoaderModule: undefined,
			clientMiddlewareModule: undefined,
			hydrateFallbackModule: undefined,
		});
		const manifest = { root: entry("root", ""), whoami: entry("whoami", "whoami", "root") };
		const build = documentBuild({
			assets: {
				entry: { module: "/assets/entry.js", imports: [] },
				routes: manifest,
				url: "/assets/manifest.js",
				version: "1",
			},
		});
		build.entry.module.default = (...args: Parameters<HandleDocumentRequestFunction>) =>
			Response.json(args[3].manifest.routes);
		const framework = runtime(build, { mode: "production" });
		const { request } = await testServer({ plugins: [], render: framework.fetch });

		const document = await request("/whoami");
		const discovery = await request("/__manifest?paths=/whoami&version=1");

		// Why through JSON: the client gets the manifest as JSON, which has no field that is `undefined`.
		const sent: unknown = await Response.json(manifest).json();
		await expect(document.json()).resolves.toStrictEqual(sent);
		await expect(discovery.json()).resolves.toStrictEqual(sent);
	});

	it("reads the client directory and prerendered paths from the build", () => {
		const framework = runtime(documentBuild(), { mode: "production" });

		expect(framework.clientDirectory).toBe("build/client");
		expect(framework.prerenderedPaths).toStrictEqual(["/whoami"]);
	});

	it("marks .data requests as data requests with React Router's content type", () => {
		const framework = runtime(documentBuild(), { mode: "production" });

		expect(framework.isDataRequest?.("/whoami.data")).toBe(true);
		expect(framework.isDataRequest?.("/whoami")).toBe(false);
		expect(framework.contentTypes).toStrictEqual({ ".data": "text/x-script" });
	});

	it("marks the route discovery manifest as a data request when discovery is lazy", () => {
		const lazy = runtime(documentBuild(), { mode: "production" });
		const custom = runtime(
			documentBuild({
				basename: "/app/",
				routeDiscovery: { mode: "lazy", manifestPath: "/routes" },
			}),
			{ mode: "production" },
		);
		const initial = runtime(
			documentBuild({ routeDiscovery: { mode: "initial", manifestPath: "/__manifest" } }),
			{ mode: "production" },
		);

		expect(lazy.isDataRequest?.("/__manifest")).toBe(true);
		expect(custom.isDataRequest?.("/app/routes")).toBe(true);
		expect(custom.isDataRequest?.("/__manifest")).toBe(false);
		expect(initial.isDataRequest?.("/__manifest")).toBe(false);
	});

	it("refuses a build with a public path other than /", () => {
		expect(() => runtime(documentBuild({ publicPath: "/docs/" }), { mode: "production" })).toThrow(
			'serves a build at "/" only, and this build has the publicPath "/docs/"',
		);
	});
});

describe("isServerBuild", () => {
	it("tells a server build from another module", () => {
		expect(isServerBuild(documentBuild())).toBe(true);
		expect(isServerBuild({ default: {} })).toBe(false);
	});
});
