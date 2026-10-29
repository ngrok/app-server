# @ngrok/app-server

A composable [Hono](https://hono.dev) app server for [React Router](https://reactrouter.com) and [TanStack Start](https://tanstack.com/start) apps. It replaces `@react-router/serve`, and it runs the same request pipeline in development and production, on Node, Bun, and Deno.

What it fixes in `@react-router/serve`:

- Each page has one URL. A page URL with the other trailing-slash form gets a 308 to it, for rendered and prerendered pages. A prerendered page answers at its own URL with a 200.
- A prerendered resource route (`llms.txt`, `sitemap.xml`, a JSON API file) and each `.data` file keep the headers their loader sent: `Content-Type`, `Cache-Control`, CORS.
- A streamed page under gzip reaches the client chunk by chunk.
- Each request gets one JSON log line in your format, static files included, and an `X-Request-Id`.
- Shutdown drains open requests with a deadline, and the keep-alive timeout outlasts the proxy's idle pool.

## Requirements

- Node.js 24+, Bun 1.3+, or Deno 2.9+
- Vite 8.3+
- React Router 8.5+, or TanStack Start 1.169+
- An ES module app and server build. The package has no CommonJS build, and the Vite plugin refuses a CommonJS server build.

## Install

```sh
pnpm add -E @ngrok/app-server hono
```

## Set up

The server has three layers:

- The core: the request pipeline, the plugins, and `createServer`. It imports Hono and nothing else.
- A framework adapter: how the framework renders a request. `react-router` and `tanstack-start` come with the package.
- A host adapter: where the server runs. `node` comes with the package. It runs one long-lived process on Node, Bun, or Deno, such as in a Docker image.

Each adapter has a build side, which the Vite config imports, and a run side, which the server build imports.

Add the Vite plugin next to the framework's plugin. For React Router:

```ts
// vite.config.ts
import { appServer } from "@ngrok/app-server/vite";
import { node } from "@ngrok/app-server/node/vite";
import { reactRouterAdapter } from "@ngrok/app-server/react-router/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		reactRouter(),
		appServer({ framework: reactRouterAdapter(), host: node(), app: "./server.ts" }),
	],
});
```

For TanStack Start:

```ts
// vite.config.ts
import { appServer } from "@ngrok/app-server/vite";
import { node } from "@ngrok/app-server/node/vite";
import { tanstackStartAdapter } from "@ngrok/app-server/tanstack-start/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		tanstackStart(),
		viteReact(),
		appServer({ framework: tanstackStartAdapter(), host: node(), app: "./server.ts" }),
	],
});
```

Write the server. Its default export is the app:

```ts
// server.ts
import { createServer, defaultPlugins } from "@ngrok/app-server";

const app = createServer({ plugins: defaultPlugins() });
app.get("/livez", (c) => c.text("ok"));
export default app;
```

Run it:

```json
{
	"scripts": {
		"start": "app-server start",
		"serve": "app-server serve"
	}
}
```

`appServer` adds `server/app-server.js` to the server build, next to the framework's own entry, which does not change. The file bundles `server.ts` with the framework's server module, so the server gets the app's path aliases and its one copy of the framework. With no `app`, the server uses the default plugins.

The build exports `appServer`, and the CLI calls it. So the copy of this package in the build runs the server, and the CLI's copy runs nothing. The CLI refuses a build from a version of this package with another entry protocol.

A React Router app with no Vite plugin also works: `app-server serve build/server/index.js` reads a plain React Router build and runs it with the CLI's copy, the node host, and the default plugins. In that build, a route that calls `shutdownSignal()`, `eventStream()`, or `requestContext()` must import the CLI's copy, so do not bundle `@ngrok/app-server` into it.

## Commands

- `app-server start`: development. Vite in middleware mode inside the pipeline, with HMR on the same port. It needs the `appServer` plugin. Each request loads the latest server entry, so an edit to a route or to `server.ts` applies at once. The port is `--port`, else `PORT`, else Vite's `server.port`. When that port is in use, `start` tries each next port, unless Vite's `server.strictPort` is true. The host is `HOST`, else Vite's `server.host`. On `SIGTERM` or `SIGINT`, it stops Vite and the server, then exits.
- `app-server serve [path]`: production. With no path, it runs the first of `build/server/app-server.js` (React Router), `dist/server/app-server.js` (TanStack Start), and `build/server/index.js` (a plain React Router build). The port is `--port`, else `PORT`, else 3000. The host is `HOST`, else every interface. A port in use stops startup at once. On `SIGTERM` or `SIGINT`, it drains, then exits, even when the app left a timer.

On Bun, run `bun node_modules/@ngrok/app-server/dist/cli.js serve`. On Deno, run `deno run --allow-net --allow-env --allow-read --allow-sys node_modules/@ngrok/app-server/dist/cli.js serve`. For `start` on Deno, also give `--allow-ffi --allow-write --ignore-read=/proc/sys/fs/binfmt_misc/WSLInterop`. Vite loads its native bundler and writes its cache. On Linux, Vite also reads a WSL file that Deno gives only to `--allow-all`.

## The pipeline

`createServer` runs the plugins in list order, then the app's own Hono routes, then the framework. `defaultPlugins()` returns this order:

1. `requestId()`: reuses a valid incoming `X-Request-Id`, else makes a UUID, and echoes it.
2. `accessLog({ redactQuery })`: one line per request when the body ends, with Datadog standard attributes (`http.status_code`, `network.bytes_written`, `duration` in nanoseconds). Query values are `REDACTED` by default.
3. `streamingCompress()`: gzip that flushes after each chunk. It skips encoded, partial, and `no-transform` responses. The host gives the gzip stream. On a host with none, the plugin does nothing.
4. The `beforeStatic` plugins: they see every response, prerendered pages included. `runtimeEnv` and `buildId` go here.
5. `assets()`: `/assets/*` with a one-year immutable cache. A missing asset gets a plain 404. In development, Vite serves here.
6. `trailingSlash({ mode })`: a 308 from a page URL to the same URL in the site's trailing-slash form. See [Trailing slashes](#trailing-slashes).
7. `prerendered({ headers, rewrite })`: every file in the client build, with an ETag and a 304 for a matching `If-None-Match`. A directory answers with its `index.html`. Each file has one URL: `/a//b`, `/a/index.html`, and `/a%2Fb` go on to the framework. Dotfiles stay private, except `/.well-known/`. A path with no file goes on to the framework.

`defaultPlugins()` is a plain array, so you can filter it or splice into it. A plugin is Hono middleware plus optional hooks:

```ts
import type { Plugin } from "@ngrok/app-server";

const securityHeaders: Plugin = {
	name: "security-headers",
	middleware: async (c, next) => {
		await next();
		c.header("X-Frame-Options", "DENY"); // `c.header` also works on a response with immutable headers
	},
	setup: (info) => {}, // once, before the first request; a throw stops startup
	onShutdown: async () => {}, // at shutdown, while the listeners drain, up to the deadline
};
```

A plugin that changes a response with a value it reads at run time, as `runtimeEnv` and `buildId` do, returns that value from `etagPart`. The server adds it to the ETag of each static file that the request reaches after the plugin, so a 304 never keeps a response made with an old value.

```ts
const version: Plugin = {
	name: "version",
	etagPart: () => process.env.APP_VERSION,
	middleware: async (c, next) => {
		await next();
		c.header("X-App-Version", process.env.APP_VERSION);
	},
};
```

## Trailing slashes

`/docs/button` and `/docs/button/` are two URLs. Choose one form for the site, and send a permanent redirect from the other form. Else a search engine and a cache keep two copies of each page. Point the canonical tag at the same form.

`defaultPlugins({ trailingSlash })` sets the form. The default is `never`:

| Mode       | `/docs/button`         | `/docs/button/`       |
| ---------- | ---------------------- | --------------------- |
| `never`    | 200                    | 308 to `/docs/button` |
| `always`   | 308 to `/docs/button/` | 200                   |
| `preserve` | 200                    | 200                   |

The redirect applies to rendered and prerendered pages, and it keeps the query string. It does not apply to `/`, a method other than GET or HEAD, a data request of the framework, or a path that one of the app's own Hono routes matches, such as `app.get("/livez")`. `always` adds no slash to a file in the client build, such as `/LICENSE`, or to a path whose last segment has a dot, such as `/llms.txt` or a `.data` request. React Router's route discovery manifest (`/__manifest`) counts as a data request.

Why 308: it is permanent, as 301 is, and a client keeps the method. Next.js and Vercel send the same status for this redirect.

### React Router

React Router has no trailing-slash option. It renders `/docs/button`, `/docs/button/`, and `/docs/button//` with a 200. So the server is the only place that makes the URL canonical. Choose the mode in `defaultPlugins`.

### TanStack Start

The TanStack router has its own `trailingSlash` option, and its default is also `never`. On the server it sends a 307 to its own form. Do not mix the two modes. When the server mode and the router mode differ, the redirects loop: the server sends `/x` to `/x/`, and the router sends `/x/` back to `/x`.

Check the server mode against the router with `RouterTrailingSlash`. It is the mode of the router in the app's `Register`, so TypeScript fails when the modes differ:

```ts
// src/router.ts
export function getRouter() {
	return createRouter({ routeTree, trailingSlash: "always" });
}
```

```ts
// server.ts
import { createServer, defaultPlugins } from "@ngrok/app-server";
import type { RouterTrailingSlash } from "@ngrok/app-server/tanstack-start";

createServer({
	plugins: defaultPlugins({ trailingSlash: "always" satisfies RouterTrailingSlash }),
});
```

`"never" satisfies RouterTrailingSlash` fails to type-check here. With no registered router, `RouterTrailingSlash` allows each mode. The server mode wins for each page, because the server redirects first. The router's 307 is temporary, and its `Location` uses the request's host, so a proxy's internal host can leak into it.

## Content negotiation

`rewrite` maps a request path to the file to serve. A rewritten path follows the same rules as a request path. This serves a prerendered markdown twin, such as `/components/button.md` for `/components/button`, to a client that asks for markdown:

```ts
import { readdirSync } from "node:fs";

const markdownPaths = new Set(
	readdirSync("build/client", { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".md"))
		.map((file) => `/${file}`),
);
const twin = (path: string) => `${path.replace(/\/+$/, "") || "/index"}.md`;

// Why a plugin: one URL answers HTML or markdown, so a shared cache must key on `Accept`.
const varyOnAccept: Plugin = {
	name: "vary-on-accept",
	middleware: async (c, next) => {
		await next();
		if (markdownPaths.has(twin(c.req.path))) {
			c.header("Vary", "Accept", { append: true });
		}
	},
};

createServer({
	plugins: defaultPlugins({
		beforeStatic: [varyOnAccept],
		prerendered: {
			rewrite: (path, c) =>
				markdownPaths.has(twin(path)) && c.req.header("Accept")?.includes("text/markdown")
					? twin(path)
					: path,
		},
	}),
});
```

Parse the `Accept` quality values when a client can send `text/markdown;q=0`.

## Prerendered headers

During the framework's prerender pass, `appServer` records each prerendered path and the response headers of each prerendered file that is not an HTML document into `.app-server.json` in the client build. `prerendered()` replays the headers. It leaves out `Set-Cookie`, `Vary`, and the headers of one transfer, such as `Content-Length`. When the framework does not list its prerendered paths, as with TanStack Start, the server reads them from this file.

A document's headers are not recorded, because the framework sets them for each request (a CSP nonce, the host). Set the headers of a prerendered page with the `headers` option or a plugin. For its CSP, use a `script-src` with the hash of each inline script, not a nonce. The prerender writes one nonce into the file, and every visitor can read it, so it protects nothing.

## Logs

Pass a sink to use your own format. Attribute names are flat and dotted:

```ts
createServer({
	logger: {
		log: (level, message, attributes) => mySlogger[level](message, attributes),
	},
});
```

The default is `jsonSink()`: one JSON object per line on stdout.

In server code, read the request ID and a logger whose lines carry it. `requestContext()` works with each framework. It gives `undefined` outside a server request, such as in a prerender pass:

```ts
import { requestContext } from "@ngrok/app-server";

export async function loader() {
	requestContext()?.logger.info("loading");
}
```

React Router also gets the values in its context, and TanStack Start gets them as `context.appServer` in its request context:

```ts
import { appServerContext } from "@ngrok/app-server/react-router";

export async function loader({ context }: Route.LoaderArgs) {
	context.get(appServerContext).logger.info("loading");
}
```

## Environment

`runtimeEnv(schema)` validates the environment once, at startup, with any [Standard Schema](https://standardschema.dev) (zod, valibot, arktype). A bad value stops the server with a message that names it.

```ts
import { createServer, defaultPlugins, runtimeEnv } from "@ngrok/app-server";
import { z } from "zod";

export const env = runtimeEnv(
	z.object({ PUBLIC_API_URL: z.url(), SESSION_KEY: z.string().min(32) }),
);

export default createServer({ plugins: defaultPlugins({ beforeStatic: [env] }) });
```

The values whose names start with `PUBLIC_` go into each HTML document at serve time, prerendered pages included, so one build serves every environment. Read them in the browser:

```ts
const publicEnv = JSON.parse(document.getElementById("app-server-public-env")?.textContent ?? "{}");
```

## Long-lived responses

`eventStream()` makes a server-sent event response that sends a heartbeat every 15 s, stops when the client disconnects, and closes at shutdown so the drain does not wait for it:

```ts
import { eventStream } from "@ngrok/app-server";

export async function loader({ request }: Route.LoaderArgs) {
	return eventStream({ signal: request.signal }, async ({ send, signal }) => {
		for await (const update of watch({ signal })) {
			send({ event: "update", data: JSON.stringify(update) });
		}
	});
}
```

For other long work, stop on `shutdownSignal()`.

## Adapters

A framework adapter or a host adapter is two small objects. A third-party adapter uses the same contract.

- `FrameworkBuild` (from `@ngrok/app-server/vite`): the framework's server module, the module of the run side, how to detect the prerender pass, and a check of the Vite config.
- `FrameworkRuntime` (from `@ngrok/app-server`): `fetch(request, context)`, plus, when the framework has them, its client build, its prerendered paths, its data requests, and the content types that `mime` lacks. The run-side module exports `runtime(serverModule, { mode })`.
- `HostBuild` (from `@ngrok/app-server/vite`): the module of the run side and the file name of the server entry.
- `HostRuntime` (from `@ngrok/app-server`): the client build's files, the default listeners, request storage for `requestContext()`, a gzip stream, and a lifecycle for a long-lived process. The run-side module exports `host`.

## Options

`createServer` takes:

- `plugins`: default `defaultPlugins()`.
- `logger`: default `jsonSink()`.
- `listeners`: default the host's listeners. A listener decides how connections arrive. On the node host, the default is `[tcp()]` from `@ngrok/app-server/node`. `tcp()` uses `node:http`, `Bun.serve`, or `Deno.serve`.
- `trustForwardedProto`: read the scheme from `X-Forwarded-Proto`. Set it only behind a proxy that overwrites the header. Default `false`. For a build with no `server.ts`, set `TRUST_FORWARDED_PROTO=1`. TanStack Start compares a server function call's `Origin` with the request URL when the browser sends no `Sec-Fetch-Site`, so set this option behind a proxy that ends TLS.
- `shutdownDeadlineMs`: default `10000`.

## Limits

- The build must serve at `/` (Vite `base`). The Vite plugin fails the build for another base.
- `appServer` does not support React Router `serverBundles`.
- The package has one host adapter, `node`. A serverless host, such as Cloudflare Workers or Vercel, needs its own adapter. See `HostRuntime` and `HostBuild`.
- On Deno, `Deno.serve` logs a notice about its legacy `request.signal` behavior.
