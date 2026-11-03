# @ngrok/app-server

A composable [Hono](https://hono.dev) app server for [React Router](https://reactrouter.com) and [TanStack Start](https://tanstack.com/start) apps. It replaces `@react-router/serve`, and it runs the same request pipeline in development and production, on Node, Bun, and Deno.

What it fixes in `@react-router/serve`:

- Each page has one URL. A page URL with the other trailing-slash form gets a 308 to it, for rendered and prerendered pages. A prerendered page answers at its own URL with a 200.
- A prerendered resource route (`llms.txt`, `sitemap.xml`, a JSON API file) and each `.data` file keep the headers their loader sent: `Content-Type`, `Cache-Control`, CORS.
- A streamed page under gzip reaches the client chunk by chunk.
- Each request gets one JSON log line in your format, static files included, and an `X-Request-Id`.
- Shutdown drains open requests with a deadline, and the keep-alive timeout outlasts the proxy's idle pool.

## Requirements

- Node.js 26+, Bun 1.3+, or Deno 2.9+
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

Each adapter has a build side, which the Vite plugin uses, and a run side, which the server build imports.

Add the Vite plugin next to the framework's plugin. For React Router:

```ts
// vite.config.ts
import { appServer } from "@ngrok/app-server/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [reactRouter(), appServer()],
});
```

For TanStack Start:

```ts
// vite.config.ts
import { appServer } from "@ngrok/app-server/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tanstackStart(), viteReact(), appServer()],
});
```

`appServer` has three options. Each one has a default:

- `framework`: the framework adapter. Default: the adapter of the framework plugin in the Vite config. The plugin of React Router is `reactRouter()`, and the plugin of TanStack Start is `tanstackStart()`. If the config has neither plugin or both, Vite stops with an error. Then pass `reactRouterAdapter()` from `@ngrok/app-server/react-router/vite` or `tanstackStartAdapter()` from `@ngrok/app-server/tanstack-start/vite`.
- `host`: the host adapter. Default: `node()` from `@ngrok/app-server/node/vite`.
- `app`: the module whose default export is the app, relative to the Vite root. Default: `server.ts`, else `server.js`, in the Vite root. If neither file exists, the server uses the default plugins.

An option that you set replaces its default. Set it for a third-party adapter or for an app in another file:

```ts
appServer({ framework: reactRouterAdapter(), host: node(), app: "./src/app.ts" });
```

Write the server. Its default export is the app:

```ts
// server.ts
import { createServer, defaultPlugins } from "@ngrok/app-server";

export default createServer({ plugins: defaultPlugins() });
```

`defaultPlugins()` answers the health probes at `/livez` and `/readyz`, and sends the build ID that tells an open tab about a deploy. Its options turn on the other plugins, each in its correct place. See [The pipeline](#the-pipeline).

Run it:

```json
{
	"scripts": {
		"start": "app-server start",
		"serve": "app-server serve"
	}
}
```

`appServer` adds `server/app-server.js` to the server build, next to the framework's own entry, which does not change. The file bundles `server.ts` with the framework's server module, so the server gets the app's path aliases and its one copy of the framework. The build also bundles the dependencies, so the build directory runs with no install. See [Deploy](#deploy).

After the build and after the prerender pass, `appServer` writes a gzip copy (`.<file>.gz`) and a brotli copy (`.<file>.br`) next to each text file of 1 kibibyte (KiB) or more in the client build, HTML pages included. It writes the gzip copy when it is smaller than the file, and the brotli copy when it is smaller than the gzip copy. `app-server serve` sends the copy that the client's `Accept-Encoding` prefers, brotli before gzip, so it does not compress the file for each request. Each copy is a dotfile, so it has no URL of its own: a `skip` rule or an auth check for the file also blocks its copies. The build does not change a `.gz` or `.br` file of the app. The copies include the prerendered files, in any plugin order. The brotli copies use quality 9, not 11: on a docs build with 70 megabytes (MB) of text, quality 11 adds 46 s to the build, and quality 9 adds 0.6 s for copies that are 9% larger. `appServer` gives a list of Vite plugins, so put it in `plugins` as it is.

The build exports `appServer`, and the CLI calls it. So the copy of this package in the build runs the server, and the CLI's copy runs nothing. The CLI refuses a build from a version of this package with another entry protocol.

A React Router app with no Vite plugin also works: `app-server serve build/server/index.js` reads a plain React Router build and runs it with the CLI's copy, the node host, and the default plugins. In that build, a route that calls `shutdownSignal()`, `eventStream()`, or `requestContext()` must import the CLI's copy, so do not bundle `@ngrok/app-server` into it.

## Commands

- `app-server start`: development. Vite in middleware mode inside the pipeline, with HMR on the same port. It needs the `appServer` plugin. Each request loads the latest server entry, so an edit to a route or to `server.ts` applies at once. The port is `--port`, else `PORT`, else Vite's `server.port`. When that port is in use, `start` tries each next port, unless Vite's `server.strictPort` is true. The host is `HOST`, else Vite's `server.host`. On `SIGTERM` or `SIGINT`, it stops Vite and the server, then exits.
- `node build/server/app-server.js`: production, with no install. Use `dist/server/app-server.js` for TanStack Start. It reads `PORT` and `HOST`, and it drains on `SIGTERM` or `SIGINT`, as `app-server serve` does. It has no `--port`. It sets `NODE_ENV` to `production` when `NODE_ENV` has no value.
- `app-server serve [path]`: production. With no path, it runs the first of `build/server/app-server.js` (React Router), `dist/server/app-server.js` (TanStack Start), and `build/server/index.js` (a plain React Router build). The port is `--port`, else `PORT`, else 3000. The host is `HOST`, else every interface. A port in use stops startup at once. On `SIGTERM` or `SIGINT`, it drains, then exits, even when the app left a timer. A server process serves the client build that was there at start. A deploy starts a new process.

`-p` is short for `--port`. `--help` writes the usage. A bad argument writes a message and the usage, and exits with code 1.

On Bun, run `bun build/server/app-server.js`, or `bun node_modules/@ngrok/app-server/dist/cli.js serve`. On Deno, run `deno run --allow-net --allow-env --allow-read --allow-sys build/server/app-server.js`, or give the same flags to `node_modules/@ngrok/app-server/dist/cli.js serve`. A native package on Deno also needs `--allow-ffi`. For `start` on Deno, also give `--allow-ffi --allow-write --ignore-read=/proc/sys/fs/binfmt_misc/WSLInterop`. Vite loads its native bundler and writes its cache. On Linux, Vite also reads a WSL file that Deno gives only to `--allow-all`.

## Deploy

`vite build`, or `react-router build`, writes a server build that runs with no `npm install`. Copy the build directory alone, and run its server entry:

- `appServer` bundles each dependency into the server build. For the build, it sets `ssr.noExternal: true`, unless the app sets its own `ssr.noExternal` or sets `ssr.external: true`.
- Some packages stay external: each package in the app's `ssr.external` or in the bundler's `external` option, the whole package of an external subpath, each peer dependency of a package that the app keeps external, the peers of each peer, and each native package. So the bundle and an external package use one copy of a package, such as `react` for a component library. The build reads the peers of a string in the bundler's `external` option, but not of a `RegExp` or a function. For those, add the peers to `ssr.external`. A package is native when a `.node` file is in it, or in a package of its `dependencies` or `optionalDependencies`. For example, `oxc-parser` gets its addon from `@oxc-parser/binding-linux-x64-gnu`.
- The build copies each external package, whole, with its installed dependencies, into `node_modules` in the server build. Each file stays where its package expects it, so CommonJS, a file read through `__dirname`, and a `.node` addon work.
- The build copies each package in `ssr.external`, also when no code imports it. So when the app reads a file of a package at run time, such as through `require.resolve`, add the package to `ssr.external`.
- The build writes a `package.json` with `"type": "module"` into the server build, so Node, Bun, and Deno load it as ES modules and find its `node_modules`.

The copy holds only the native addon that the install put on the build machine. So run the build on the platform of the server, such as in the builder stage of a Docker image:

```dockerfile
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM gcr.io/distroless/nodejs26-debian13
WORKDIR /app
COPY --from=build /app/build ./build
EXPOSE 3000
# The image runs `node` with these arguments.
CMD ["build/server/app-server.js"]
```

For TanStack Start, copy `dist`, and run `dist/server/app-server.js`.

## The pipeline

`createServer` runs the plugins in list order, then the app's own Hono routes, then the framework. `defaultPlugins()` returns this order:

1. `health()`: the liveness and readiness probes at `/livez` and `/readyz`. A probe skips the access log. `defaultPlugins({ health })` changes them, and `false` turns them off. See [Health checks](#health-checks).
2. `requestId()`: reuses a valid incoming `X-Request-Id`, else makes a UUID, and echoes it.
3. `accessLog({ redactQuery })`: one line per request when the body ends, with Datadog standard attributes (`http.status_code`, `network.bytes_written`, `duration` in nanoseconds). Query values are `REDACTED` by default.
4. `streamingCompress()`: gzip that flushes after each chunk. It skips encoded, partial, and `no-transform` responses, and a body under 1,024 bytes: by its `Content-Length`, or a body from a string. It adds `Accept-Encoding` to `Vary` only on a type that it can gzip. A static file with a compressed copy from the build gets that copy, and this plugin skips it. It follows the `q` values of `Accept-Encoding`, and `q=0` refuses gzip. The host gives the gzip stream. On a host with none, the plugin does nothing.
5. `securityHeaders()`: safe default security headers on each response, prerendered pages included. `defaultPlugins({ securityHeaders })` changes them, and `false` turns them off. See [Security headers](#security-headers).
6. `bodyLimit({ maxBytes })`: a 413 for a request body over `defaultPlugins({ bodyLimit })`, 10 mebibytes (MiB) by default. `false` turns it off. A `Content-Length` that is too large gets the 413 before the app runs. A streamed body errors when it passes the limit. When the app reads the body before it answers, the response becomes a 413. When the app streams the body into its response, the response stream errors. A `bodyLimit` that is not a whole number of 0 or more stops startup. The body streams. The plugin does not read it into memory.
7. The plugins of the named options. They see every response, prerendered pages included:
   - `noindex()`, with `defaultPlugins({ noindex: true })`. See [Preview deploys](#preview-deploys).
   - `buildId()`, on by default. `defaultPlugins({ buildId })` changes it, and `false` turns it off. See [Deploys and open tabs](#deploys-and-open-tabs).
   - `contentSecurityPolicy()`, with `defaultPlugins({ contentSecurityPolicy })`. See [A CSP for each document](#a-csp-for-each-document).
   - The plugin from `runtimeEnv()`, with `defaultPlugins({ env })`. See [Environment](#environment).
8. The `beforeStatic` plugins: the app's own plugins that see every response, prerendered pages included, such as an auth check. They come after the plugins of the named options, so they get the CSP nonce, and their responses get the headers of those plugins.
9. `assets()`: `/assets/*` with a one-year immutable cache. A missing asset gets a plain 404 with `Cache-Control: no-store`. In development, Vite serves here. See [Deploys and open tabs](#deploys-and-open-tabs).
10. `redirects(rules)`, when `defaultPlugins({ redirects })` has rules: a redirect from each old URL to its new URL. See [Redirects](#redirects).
11. `trailingSlash({ mode })`: a 308 from a page URL to the same URL in the site's trailing-slash form. See [Trailing slashes](#trailing-slashes).
12. `prerendered({ headers, rewrite, skip, cacheControl })`: every file in the client build, with an ETag, a 304 for a matching `If-None-Match`, and a 206 for one byte range of a file that is not HTML. An HTML page, a markdown file, and a data file of the framework get `Cache-Control: public, max-age=0, must-revalidate`, and every other file gets `public, max-age=3600, stale-while-revalidate=86400`. A captured header, the `headers` option, and `cacheControl` change it. A file with a compressed copy from the build gets `Vary: Accept-Encoding`. A client gets the copy that its `Accept-Encoding` prefers, brotli before gzip, with no byte ranges and an ETag for that encoding. A `no-transform` response never gets a copy, and an HTML page gets none when `runtimeEnv` adds values to it. A directory answers with its `index.html`. Each file has one URL: `/a//b`, `/a/index.html`, and `/a%2Fb` go on to the framework. Dotfiles stay private, except `/.well-known/`. A path with no file, or a path that `skip` matches, goes on to the framework.
13. `privateDocuments()`: `Cache-Control: private, no-cache` on each HTML document and each framework data response (such as a React Router `.data` request) from the app's routes or the framework that has no `Cache-Control`. A shared cache then never keeps a page or loader data that the server rendered for one user. A response with its own `Cache-Control` keeps it. A resource route that sends per-user JSON sets its own `Cache-Control`.

A route that takes a body larger than the limit needs a higher `bodyLimit` for the whole app, because each request passes the limit before it reaches a route.

`defaultPlugins()` is a plain array, so you can filter it or splice into it. A plugin of a named option in `beforeStatic`, such as `buildId()`, stops startup, so a plugin never runs twice. Use the option. A plugin is Hono middleware plus optional hooks:

```ts
import { withHeaderHook } from "@ngrok/app-server";
import type { Plugin } from "@ngrok/app-server";

const frameOptions: Plugin = {
	name: "frame-options",
	middleware: async (c, next) =>
		withHeaderHook(c, next, (response) => {
			response.set("X-Frame-Options", "DENY");
		}),
	setup: (info) => {}, // once, before the first request; a throw stops startup
	onShutdown: async () => {}, // at shutdown, while the listeners drain, up to the deadline
};
```

A plugin that sets a header on the response uses `withHeaderHook`. The hook runs after the later stages, as code after `await next()` does. In development, Vite answers some requests itself, such as source modules and `public/` files, and sends the response before the earlier stages get it back. The hook also runs on those responses, before Vite sends the head, so each response gets the same headers in development and in production. A hook can `get`, `has`, `set`, `append`, and `delete` a header.

A plugin that changes a response with a value it reads at run time, as `runtimeEnv` and `buildId` do, returns that value from `etagPart`. The server adds it to the ETag of each static file that the request reaches after the plugin, so a 304 never keeps a response made with an old value.

```ts
const version: Plugin = {
	name: "version",
	etagPart: () => process.env.APP_VERSION,
	middleware: async (c, next) =>
		withHeaderHook(c, next, (response) => {
			response.set("X-App-Version", process.env.APP_VERSION ?? "dev");
		}),
};
```

A `beforeStatic` plugin that changes the bytes of an HTML page, as `runtimeEnv` does, calls `c.set("rewritesHtml", true)` before its `next()`. The static stages then send the HTML file as it is on disk, not its compressed copy. Without it, a client that accepts gzip or brotli gets the copy, with a `Content-Encoding` that the plugin must not change.

## Protect pages

`prerendered()` answers before the app's own routes and before the framework. So an auth check in a loader or in a `server.ts` route never runs for a prerendered file. A prerendered app shell at `/app` goes to a visitor with no session.

Use one of these two fixes:

- Put the auth check in `beforeStatic`. It then runs before each prerendered file and its data file.
- Send the private paths to the framework with `prerendered({ skip })`, and keep the auth check in the app.

An auth plugin sets `Cache-Control: private` on each response that it lets through. Else a CDN can give a protected file to every visitor.

```ts
import { createServer, defaultPlugins, withHeaderHook } from "@ngrok/app-server";
import type { Plugin } from "@ngrok/app-server";

const auth: Plugin = {
	name: "auth",
	middleware: async (c, next) => {
		if (!c.req.path.startsWith("/app")) {
			return next();
		}
		if (!(await hasSession(c.req.raw))) {
			return c.redirect("/login", 302);
		}
		await withHeaderHook(c, next, (response) => {
			response.set("Cache-Control", "private, no-cache");
		});
	},
};

export default createServer({ plugins: defaultPlugins({ beforeStatic: [auth] }) });
```

`hasSession` stands for the app's own session check.

## Security headers

`defaultPlugins()` runs `securityHeaders()`. It sets these headers on each response, prerendered pages included:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Cross-Origin-Opener-Policy: same-origin`
- `Strict-Transport-Security: max-age=31536000`, on an HTTPS request only

A response that has one of these headers keeps its own value. `false` turns a header off, and `defaultPlugins({ securityHeaders: false })` turns them all off.

```ts
defaultPlugins({
	securityHeaders: {
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin-allow-popups",
			"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
			"Content-Security-Policy": "frame-ancestors 'none'",
		},
	},
});
```

- `Cross-Origin-Opener-Policy: same-origin` breaks a pop-up that talks to the page through `window.opener`, such as some OAuth and payment pop-ups. Set `same-origin-allow-popups` for such a site.
- A browser keeps `Strict-Transport-Security` for its `max-age`. Add `includeSubDomains` only when each subdomain serves HTTPS. Behind a proxy that ends TLS, set `trustForwardedProto`, else the server sees an HTTP request and sends no HSTS.
- `Content-Security-Policy` has no default, so another site can put the page in a frame. Set `frame-ancestors 'none'` to stop that. The plugin adds the value as a second policy, next to the response's own policy, and a browser enforces both.

### A CSP for each document

`contentSecurityPolicy({ policy })` sets the `Content-Security-Policy` from `policy` on each HTML document that has none. `policy` gets the `script-src` source list that trusts the document's scripts, and the request's Hono context, so the policy can change by path:

- A rendered document gets `'nonce-…' 'strict-dynamic'`, with a new nonce for each request.
- A prerendered document gets `'self'` and the hash of each of its inline scripts, such as `'self' 'sha256-…'`. The `appServer` Vite plugin records the hashes. The prerender writes one nonce into the file, and every visitor can read it, so a nonce protects nothing. A hash does not carry to the imports of an inline module script, so this list has no `'strict-dynamic'`.

If the build recorded no hashes for an HTML file, the list is only `'self'`, and the browser blocks the file's inline scripts. A 304 for a prerendered document gets the policy too, because a browser replaces the policy of its cached copy with the policy of the 304. The `contentSecurityPolicy` option of `defaultPlugins()` puts the plugin before the static stages, so it sees the prerendered documents.

```ts
createServer({
	plugins: defaultPlugins({
		contentSecurityPolicy: {
			policy: (scriptSrc) => `script-src ${scriptSrc}; object-src 'none'; base-uri 'none'`,
		},
	}),
});
```

Give the nonce to the framework's render. `requestContext()?.cspNonce` has it. In React Router, do it in `app/entry.server.tsx`:

```tsx
const nonce = requestContext()?.cspNonce;
const { pipe } = renderToPipeableStream(
	<ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
	{ nonce /* , … */ },
);
```

In TanStack Start, give it to the router:

```ts
export function getRouter() {
	return createRouter({ routeTree, ssr: { nonce: requestContext()?.cspNonce } });
}
```

## Deploys and open tabs

After a deploy, an open tab still runs the old build. Two things can then go wrong:

- **Old assets.** The tab asks for a chunk of its own build, such as `/assets/route-3f9a1c.js`, and the new server does not have it. Keep the `/assets/*` files of each build, with their `.<file>.gz` and `.<file>.br` copies, in storage that a deploy never deletes, such as an object store behind the CDN. File names are content hashes, so the builds never collide. The server sends `Cache-Control: no-store` with a missing asset, so a CDN does not keep the 404.
- **New data for old code.** The router fetches data from the new server, such as a React Router `.data` file or a TanStack Start server function, and the old code renders it. A changed loader can break the page.

`buildId()` and the client module fix the second problem at the next navigation, and the page that the visitor reads never reloads. For React Router, create the module once, and give its three hooks to the router:

```ts
// app/stale-build.ts (React Router)
import { staleBuildReactRouter } from "@ngrok/app-server/client";

export const staleBuild = staleBuildReactRouter({
	onNewBuild: (build) => datadogRum.addAction("new build", { build }),
});
```

```tsx
// app/root.tsx
export const clientMiddleware = [staleBuild.middleware];
```

```tsx
// app/entry.client.tsx
startTransition(() => {
	hydrateRoot(
		document,
		<HydratedRouter
			unstable_fetch={staleBuild.fetch}
			instrumentations={[staleBuild.instrumentation]}
		/>,
	);
});
```

For TanStack Start, give it the router, on the client only:

```tsx
// src/router.tsx (TanStack Start)
import { staleBuildTanStack } from "@ngrok/app-server/client";

export function getRouter() {
	const router = createRouter({ routeTree });
	if (!router.isServer) {
		staleBuildTanStack(router);
	}
	return router;
}
```

The server needs no code: `defaultPlugins()` runs `buildId()` with the ID of the client build.

- After the client build, the `appServer` Vite plugin hashes the name and the content of each file of the client bundle. After the server build, it adds each file that the server build wrote to the client's assets directory, such as the React Router route manifest. It writes the hash as `buildId` in `.app-server.json`. The ID changes when the code or the routes that an open tab runs change. A deploy that changes only the server, a `public/` file, or a prerendered page keeps the ID, so an open tab does not move for nothing.
- To send another ID, such as the image tag, set `value`. With no value, such as an unset or empty variable, the server sends the build's ID:

  ```ts
  // server.ts
  defaultPlugins({ buildId: { value: process.env.IMAGE_TAG } });
  ```

- In development, the server sends no build ID unless `value` is set, because Vite's hot module replacement (HMR) updates an open tab after each edit.
- A build with no `appServer` Vite plugin has no ID. Set `value` for it.
- `buildId()` sends the build on each document and data response, as `X-Build-Id` and in `Server-Timing`.
- The module reads the build from the responses that the router fetches, and from the responses of this origin that the browser fetches with no script, such as a `<Link prefetch="intent">` hover. A prefetch can show a new build before the click. A build from another origin does not count.
- The router tells the module when a navigation starts, after its blockers. So a canceled link, `navigate()`, a form, a history step, and `blocker.proceed()` each act as the router acts.
- If a data request of a navigation gets a response from a new build, the browser loads the target URL as a document. The old code never gets the new data.
- If the tab already knows of a new build, the next navigation loads its target as a document before the old code renders it. With React Router, the root middleware does this for each `navigate` call, also to a route with no loader, and the router sends no data request. TanStack Router does this for each navigation to a new path or query, and clears its cache first, so the old code never renders the data of a preload.
- The document load keeps the URL fragment, such as `#usage`, and a replace navigation stays a replace.
- A revalidation, a fetcher, an action, the loaders after an action, and a request outside a navigation get their response, and only mark the tab. The page that the visitor reads never reloads, and a form keeps its result.
- A change to the fragment stays in the page.
- `onNewBuild(served)` runs once, when the tab first sees another build. Use it to count stale tabs in the app's RUM tool.
- `app/root.tsx` also runs on the server. The module reads no browser state until React Router calls it.
- With React Router, a history step to a route with no loader stays on the old build. The next link moves the tab.
- `unstable_fetch` is an experimental React Router prop, and the middleware reads `unstable_initiator` and `unstable_navigationType` from its arguments. React Router can change them.

The module sees a build only in a response from this server. By default, that is a document, a data request of the router, or a route discovery request. An app that loads its data in the browser, such as with TanStack Query, sends few of those. Send its queries through proxy routes on this server, as the next section shows, and each query also carries the build. A request that goes to another service directly carries no build, and that service must stay compatible with old clients.

### Proxy routes

A proxy route on this server forwards a request from the browser to the app's API, such as `/api/*`. The request makes the round trip anyway, so its response can carry the build at no cost. Add the routes to `paths`:

```ts
// server.ts
const app = createServer({
	plugins: defaultPlugins({ buildId: { paths: (path) => path.startsWith("/api/") } }),
});
```

- The proxy route does not change. It can be a Hono route in `server.ts` or a React Router resource route.
- Each query and mutation through the route now tells the tab about a new build, so a tab finds a deploy at its next request, and moves to the new build at its next navigation.
- The tab never reloads the page that the visitor reads. A query that finds a new build only marks the tab.
- The response carries the build in `Server-Timing` only, with no `X-Build-Id`. The client reads it from resource timing, so a fetch client that keeps its own copy of `fetch` still reports the build. `staleBuildTanStack()` also reads it from each `fetch` response, so a loader that gets the new build's data in a navigation loads the page as a document.
- `buildId()` removes the `X-Build-Id` header and the `build` metric of the upstream API from each response, so the client reads only this app's build.
- A response that a cache can use again without the server gets no build, so a cached copy never reports an old build. That is a response with `public`, a `max-age`, an `s-maxage`, a stale time, a future `Expires`, or a `Last-Modified`, and with no `no-cache` or `no-store`.

The client module sends no request of its own and adds no wait. A client navigation makes the same requests with it as without it. It reads the build from the responses that the router already fetches. After a deploy, one navigation loads its target as a document: at most one more request, once for each deploy. Polling the server or checking the build before each navigation would add a round trip to every navigation. See [add no round trips to a client navigation](./docs/principles/no-added-round-trips.md).

## Trailing slashes

`/docs/button` and `/docs/button/` are two URLs. Choose one form for the site, and send a permanent redirect from the other form. Else a search engine and a cache keep two copies of each page. Point the canonical tag at the same form.

`defaultPlugins({ trailingSlash })` sets the form. The default is `never`:

| Mode       | `/docs/button`         | `/docs/button/`       |
| ---------- | ---------------------- | --------------------- |
| `never`    | 200                    | 308 to `/docs/button` |
| `always`   | 308 to `/docs/button/` | 200                   |
| `preserve` | 200                    | 200                   |

The redirect applies to rendered and prerendered pages, and it keeps the query string. It does not apply to `/`, a method other than GET or HEAD, a data request of the framework, or a path that one of the app's own Hono routes matches, such as `app.get("/api/status")`. `always` adds no slash to a file in the client build, such as `/LICENSE`, or to a path whose last segment has a dot, such as `/llms.txt` or a `.data` request. React Router's route discovery manifest (`/__manifest`) counts as a data request.

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

## Redirects

A site that moves pages sends a permanent redirect from each old URL. `defaultPlugins({ redirects })` takes a table:

```ts
defaultPlugins({
	redirects: [
		{ from: "/pricing-old", to: "/pricing" },
		{ from: "/blog/:slug", to: "/articles/:slug" },
		{ from: "/docs/*", to: "https://docs.example.com/*", status: 308 },
	],
});
```

- A `:name` segment matches one path segment. A `*` last segment matches the rest of the path, or nothing, so `/docs/*` also matches `/docs`. The target can use each of them. An absolute target is percent-encoded as UTF-8. In the query of the target, a value gets `&`, `=`, and `+` encoded, so it stays one value.
- The status is 301 by default, or 308 to keep the method. The redirect keeps the query string, and puts it before the fragment of the target. It applies to GET and HEAD only.
- The first rule that matches wins. A trailing slash does not change the match. The table runs before `trailingSlash`, so `/pricing-old/` gets one redirect to `/pricing`. In the `never` mode, a local target loses its trailing slash, so `trailingSlash` does not redirect it again.
- The rules compile at startup. A rule that is not valid stops startup. A local target must be a safe local path, and an absolute target must keep the origin that its rule names. A request whose values break either check gets no redirect.
- A request that is already at the target of its rule gets no redirect, so `{ from: "/tags/:tag", to: "/tags/:tag/" }` with `trailingSlash: "always"` does not loop.

### Preview deploys

`noindex()` sets `X-Robots-Tag: noindex, nofollow` on each response, prerendered pages included, so a search engine does not index a preview deploy. Turn it on from the environment:

```ts
defaultPlugins({ noindex: process.env.PREVIEW === "1" });
```

## Content negotiation

One URL can answer HTML to a browser and markdown to an agent, per [acceptmarkdown.com](https://acceptmarkdown.com). `prefersMarkdown(request)` decides which answer a request gets. Use it in the server, in a plugin, and in the app, so each place answers one request the same way.

```ts
import { prefersMarkdown } from "@ngrok/app-server";

prefersMarkdown(new Request(url, { headers: { Accept: "text/markdown" } })); // => true
prefersMarkdown(new Request(url, { headers: { Accept: "text/html, text/markdown;q=0.5" } })); // => false
```

It returns `true` when these conditions are all true:

- The `Accept` header names `text/markdown`. A wildcard (`*/*`, `text/*`) never selects markdown, so a browser gets HTML.
- The `q` of `text/markdown` is more than 0.
- The `q` of `text/markdown` is equal to or more than the `q` of HTML. The `q` of HTML comes from the most specific range: `text/html`, then `text/*`, then `*/*`. A tie selects markdown.
- Both answers are UTF-8. A range with `charset=utf-8` wins over the same type with no charset, and a range with another charset does not match.

When a URL has both answers, follow these rules:

- Send `Vary: Accept` on both answers. Else a shared cache can give the markdown to a browser.
- Send no `Vary: Accept` for a URL with only one answer, such as the `.md` URL itself.
- Send the markdown with `Content-Type: text/markdown; charset=utf-8`.
- If the markdown also has its own URL, send `Link: <url>; rel="alternate"; type="text/markdown"` with the HTML, so a client that does not ask for markdown can find it.

### A prerendered markdown twin

When the build prerenders a markdown twin for each page, such as `/components/button.md` for `/components/button`, turn on `markdownTwins`:

```ts
createServer({ plugins: defaultPlugins({ prerendered: { markdownTwins: true } }) });
```

- A request that `prefersMarkdown` accepts gets the twin, with the twin's captured headers.
- Each answer for a page with a twin gets `Vary: Accept`: the twin, the prerendered HTML, and the framework's answer for a rendered page. The server adds `Accept` to the `Vary` values that are already there.
- Each answer for a page with a twin, except the twin, gets `Link: </components/button.md>; rel="alternate"; type="text/markdown"`, so a client can find the twin.
- A page with no twin, and the twin's own URL, get no `Vary: Accept` and no `Link`.
- In development, the client build has no twins. A request that `prefersMarkdown` accepts gets the framework's answer for the twin's URL, so an edit to the twin's route shows at the next request. If that answer is an error, such as a 404, or is not markdown, the request gets the HTML. A 304 stays a 304. A browser's answer gets no `Vary: Accept` and no `Link`, because the server does not ask the framework for a twin that it does not send.
- In development, React Router gives only the twins in its `prerender` config, as the build does. TanStack Start finds its prerendered pages only during the build, so in development each twin route that answers markdown counts.
- A plugin after `prerendered` does not see a twin, in development or in production, because a twin is a prerendered file. Put an auth check for a twin in `beforeStatic` or in the twin's route.

The default twin is the path with no trailing slash plus `.md`, and `/index.md` for `/`. A different mapping goes in `twinOf`. Its path follows the same rules as a request path:

```ts
prerendered({ markdownTwins: { twinOf: (path) => (path === "/" ? "/llms.md" : `${path}.md`) } });
```

The framework makes the twins. In React Router, one splat resource route can answer every twin. Prerender each twin URL, and point `twinOf` at the route. `markdownFor` stands for the app's own lookup:

```ts
// app/routes.ts
route("markdown/*", "routes/markdown.ts");

// app/routes/markdown.ts
export async function loader({ params }: Route.LoaderArgs) {
	const markdown = await markdownFor(params["*"]); // "docs/button.md"
	if (markdown == null) {
		throw new Response("Not Found", { status: 404 });
	}
	return new Response(markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}

// react-router.config.ts
export default { prerender: ["/docs/button", "/markdown/docs/button.md"] };

// server.ts
const twinOf = (path: string) => `/markdown${path === "/" ? "/index" : path}.md`;
createServer({ plugins: defaultPlugins({ prerendered: { markdownTwins: { twinOf } } }) });
```

The same route answers the twins in development.

For other negotiation, `rewrite` maps a request path to the file to serve. It does not run for a request that gets the twin. When its answer depends on a request header, add a `Vary` for that header in a plugin.

### A rendered page

A page that the framework renders for each request negotiates in the app. In React Router, do it in `handleRequest` in `app/entry.server.tsx`. `markdownFor` stands for the app's own lookup:

```ts
import { prefersMarkdown } from "@ngrok/app-server";

export default async function handleRequest(
	request: Request,
	status: number,
	headers: Headers /* , … */,
) {
	const markdown = markdownFor(new URL(request.url).pathname);
	if (markdown != null) {
		headers.append("Vary", "Accept");
		if (prefersMarkdown(request)) {
			headers.set("Content-Type", "text/markdown; charset=utf-8");
			return new Response(markdown, { status, headers });
		}
	}
	// Render the HTML as usual. The `Vary` header goes with it.
}
```

A resource route, or a TanStack Start server route, gets the same `Request`. Call `prefersMarkdown(request)` there.

## Prerendered headers

During the framework's prerender pass, `appServer` records each prerendered path and the response headers of each prerendered file that is not an HTML document into `.app-server.json` in the client build. `prerendered()` replays the headers. It leaves out `Set-Cookie`, `Vary`, and the headers of one transfer, such as `Content-Length`. When the framework does not list its prerendered paths, as with TanStack Start, the server reads them from this file.

A document's headers are not recorded, because the framework sets them for each request (a CSP nonce, the host). Set the headers of a prerendered page with the `headers` option or a plugin. The file also records the hash of each inline script of each HTML file in the client build, so `contentSecurityPolicy()` can give a prerendered page a CSP. See [A CSP for each document](#a-csp-for-each-document). It also holds the build ID. See [Deploys and open tabs](#deploys-and-open-tabs).

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

A request with a valid W3C `traceparent` header logs `trace_id` and `span_id` on each line. `requestId({ datadogTraceIds: true })` also logs `dd.trace_id` and `dd.span_id`, the lower 64 bits in decimal, so Datadog connects each line to its trace.

`accessLog({ attributes })` adds the app's own attributes to each request line. `accessLog({ serverTiming: true })` sets `Server-Timing: app;dur=<ms>` on each HTML document: the time until the response headers were ready.

```ts
defaultPlugins({
	requestId: { datadogTraceIds: true },
	accessLog: { attributes: (c) => ({ "usr.id": c.get("userId") }) },
});
```

## Health checks

`health()` answers `/livez` and `/readyz` with `Cache-Control: no-store`. `/livez` always answers 200. `/readyz` answers 200 until the server gets a stop signal, then 503. `ready` adds an app check, such as a database ping. When the check starts to fail, one warn line goes to the log, and when it passes again, one info line. A stop signal during the check also gives 503. `defaultPlugins()` runs `health()` first, so a probe skips the access log. Its `health` option takes the options of `health()`:

```ts
export default createServer({
	plugins: defaultPlugins({ health: { ready: async () => db.ping() } }),
	shutdownDelayMs: 5_000,
});
```

`livePath` and `readyPath` move the probes. `defaultPlugins({ health: false })` turns them off, such as for an app with its own `/livez` route.

On a stop signal, a load balancer removes the server some seconds later. Without a delay, the requests that it sends in that time fail. With `shutdownDelayMs`, the server answers 503 on `/readyz` and serves the other requests for that time. Then it drains. In Kubernetes, set `terminationGracePeriodSeconds` to more than the delay plus `shutdownDeadlineMs`:

```yaml
spec:
  terminationGracePeriodSeconds: 20 # 5 s delay + 10 s drain + margin
  containers:
    - name: app
      readinessProbe:
        httpGet: { path: /readyz, port: 3000 }
        periodSeconds: 2
      livenessProbe:
        httpGet: { path: /livez, port: 3000 }
```

## Environment

`runtimeEnv(schema)` validates the environment once, at startup, with any [Standard Schema](https://standardschema.dev) (zod, valibot, arktype). A bad value stops the server with a message that names it. Give the plugin to the `env` option of `defaultPlugins()`.

```ts
import { createServer, defaultPlugins, runtimeEnv } from "@ngrok/app-server";
import { z } from "zod";

export const env = runtimeEnv(
	z.object({ PUBLIC_API_URL: z.url(), SESSION_KEY: z.string().min(32) }),
);

export default createServer({ plugins: defaultPlugins({ env }) });
```

The values whose names start with `PUBLIC_` go into each HTML document at serve time, prerendered pages included, so one build serves every environment. Read them in the browser:

```ts
const publicEnv = JSON.parse(document.getElementById("app-server-public-env")?.textContent ?? "{}");
```

When there are public values, the server sends each prerendered page from its file, not from its compressed copy, because the values change the bytes of the page. `streamingCompress()` then gzips the page for each request.

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
- `HostRuntime` (from `@ngrok/app-server`): the client build's files, the default listeners, request storage for `requestContext()`, a gzip stream, and a lifecycle for a long-lived process. The run-side module exports `host`. `files(...).open(path, range)` must honor `range`, because the static stages send those bytes in a 206. An optional `files(...).snapshot()` lists the client build once. The production server calls it at start, answers each lookup from that list, and keeps each file up to 256 KiB in memory after the first read, up to 32 MiB in all. The `.<file>.gz` and `.<file>.br` copies count in that limit. A client that accepts brotli reads only the `.br` copies, so the copies make the memory that a site needs smaller. If clients read each file in all three forms, a large site can need more than 32 MiB. Then the files that the server reads last stream from disk. Restart the server after you change the client build. A file that you remove while it runs gets a 500, unless it is in memory.

## Options

`createServer` takes:

- `plugins`: default `defaultPlugins()`.
- `logger`: default `jsonSink()`.
- `listeners`: default the host's listeners. A listener decides how connections arrive. On the node host, the default is `[tcp()]` from `@ngrok/app-server/node`. `tcp()` uses `node:http`, `Bun.serve`, or `Deno.serve`.
- `trustForwardedProto`: read the scheme from `X-Forwarded-Proto`. Set it only behind a proxy that overwrites the header. Default `false`. For a build with no `server.ts`, set `TRUST_FORWARDED_PROTO=1`. TanStack Start compares a server function call's `Origin` with the request URL when the browser sends no `Sec-Fetch-Site`, so set this option behind a proxy that ends TLS.
- `trustedProxyHops`: how many proxies in front of the server add to `X-Forwarded-For`, such as `1` behind the ngrok edge. With N, the client address is the Nth address from the right of that header. The access log and `requestContext()?.clientAddress` use it. Default `0`, the address of the socket. Set it only to the number of proxies that you run, else a client can spoof its address. For a build with no `server.ts`, set `TRUSTED_PROXY_HOPS`.
- `shutdownDelayMs`: how long the listeners serve on after a stop signal, before the drain starts. See [Health checks](#health-checks). Default `0`.
- `shutdownDeadlineMs`: how long open requests get to finish after the drain starts. Default `10000`.

## Limits

- The build must serve at `/` (Vite `base`). The Vite plugin fails the build for another base.
- `appServer` does not support React Router `serverBundles`.
- The server build holds one copy of each external package. If the build finds two copies of one external package, such as two versions, the build fails.
- One server process uses one CPU core. To use more cores, run one replica or one container for each core behind the load balancer.
- The package has one host adapter, `node`. A serverless host, such as Cloudflare Workers or Vercel, needs its own adapter. See `HostRuntime` and `HostBuild`.
- On Deno, `Deno.serve` logs a notice about its legacy `request.signal` behavior.
