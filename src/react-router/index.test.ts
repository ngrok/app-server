import { RouterContextProvider } from "react-router";
import type { HandleDocumentRequestFunction, ServerBuild } from "react-router";
import { describe, expect, it } from "vitest";
import { requestId } from "../core/plugins/request-id.js";
import { appServerContext, isServerBuild, runtime } from "./index.js";
import { testServer } from "../test-server.js";

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
