import type { HandleDocumentRequestFunction, ServerBuild } from "react-router";
import { describe, expect, it } from "vitest";
import { requestId } from "./plugins/request-id.js";
import { appServerContext, createAdapter, isServerBuild } from "./react-router.js";
import { testServer } from "./test-server.js";

/** A server build with one page, `/whoami`, whose document reads the app server context. */
function documentBuild(overrides: Partial<ServerBuild> = {}): ServerBuild {
	return {
		entry: {
			module: {
				// Why the rest parameter: React Router passes the load context fifth.
				default: (...[, , , , loadContext]: Parameters<HandleDocumentRequestFunction>) =>
					Response.json({ requestId: loadContext.get(appServerContext).requestId }),
			},
		},
		routes: {
			root: { id: "root", path: "", parentId: undefined, module: { default: () => null } },
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

describe("createAdapter", () => {
	it("passes the request ID to the server render through appServerContext", async () => {
		const framework = createAdapter(documentBuild(), { mode: "production" });
		const { request } = await testServer({ plugins: [requestId()], render: framework.fetch });

		const response = await request("/whoami", { headers: { "X-Request-Id": "abc-123" } });

		expect(await response.json()).toEqual({ requestId: "abc-123" });
	});

	it("reads the client directory and prerendered paths from the build", () => {
		const framework = createAdapter(documentBuild(), { mode: "production" });

		expect(framework.clientDirectory).toBe(`${process.cwd()}/build/client`);
		expect(framework.prerenderedPaths).toEqual(["/whoami"]);
	});

	it("refuses a build with a public path other than /", () => {
		expect(() =>
			createAdapter(documentBuild({ publicPath: "/docs/" }), { mode: "production" }),
		).toThrow('serves a build at "/" only, and this build has the publicPath "/docs/"');
	});
});

describe("isServerBuild", () => {
	it("tells a server build from another module", () => {
		expect(isServerBuild(documentBuild())).toBe(true);
		expect(isServerBuild({ default: {} })).toBe(false);
	});
});
