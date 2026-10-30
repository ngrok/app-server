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
4. `securityHeaders()`: safe default security headers on each response, prerendered pages included. `defaultPlugins({ securityHeaders })` changes them, and `false` turns them off. See [Security headers](#security-headers).
5. `bodyLimit({ maxBytes })`: a 413 for a request body over `defaultPlugins({ bodyLimit })`, 10 MiB by default. `false` turns it off. A `Content-Length` that is too large gets the 413 before the app runs. A streamed body errors when it passes the limit. When the app reads the body before it answers, the response becomes a 413. When the app streams the body into its response, the response stream errors. A `bodyLimit` that is not a whole number of 0 or more stops startup. The body streams. The plugin does not read it into memory.
6. The `beforeStatic` plugins: they see every response, prerendered pages included. `runtimeEnv`, `buildId`, and an auth check go here.
7. `assets()`: `/assets/*` with a one-year immutable cache. A missing asset gets a plain 404 with `Cache-Control: no-store`. In development, Vite serves here. See [Deploys and open tabs](#deploys-and-open-tabs).
8. `redirects(rules)`, when `defaultPlugins({ redirects })` has rules: a redirect from each old URL to its new URL. See [Redirects](#redirects).
9. `trailingSlash({ mode })`: a 308 from a page URL to the same URL in the site's trailing-slash form. See [Trailing slashes](#trailing-slashes).
10. `prerendered({ headers, rewrite, skip, cacheControl })`: every file in the client build, with an ETag, a 304 for a matching `If-None-Match`, and a 206 for one byte range of a file that is not HTML. An HTML page, a markdown file, and a data file of the framework get `Cache-Control: public, max-age=0, must-revalidate`, and every other file gets `public, max-age=3600, stale-while-revalidate=86400`. A captured header, the `headers` option, and `cacheControl` change it. A directory answers with its `index.html`. Each file has one URL: `/a//b`, `/a/index.html`, and `/a%2Fb` go on to the framework. Dotfiles stay private, except `/.well-known/`. A path with no file, or a path that `skip` matches, goes on to the framework.
11. `privateDocuments()`: `Cache-Control: private, no-cache` on each HTML document and each framework data response (such as a React Router `.data` request) from the app's routes or the framework that has no `Cache-Control`. A shared cache then never keeps a page or loader data that the server rendered for one user. A response with its own `Cache-Control` keeps it. A resource route that sends per-user JSON sets its own `Cache-Control`.

A route that takes a body larger than the limit needs a higher `bodyLimit` for the whole app, because each request passes the limit before it reaches a route.

`defaultPlugins()` is a plain array, so you can filter it or splice into it. A plugin is Hono middleware plus optional hooks:

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

A plugin that sets a header on the response uses `withHeaderHook`. The hook runs after the later stages, as code after `await next()` does. In development, Vite answers some requests itself, such as source modules and `public/` files, and sends the response before the earlier stages get it back. The hook also runs on those responses, before Vite sends the head, so each response gets the same headers in development and in production. A hook can `get`, `has`, `set`, and `append` a header.

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

### A CSP nonce for each request

`cspNonce({ policy })` makes a random nonce for each request that reaches the app's routes or the framework. It sets the `Content-Security-Policy` from `policy` on each HTML document that has none. Put it after the static stages. A prerendered page has one nonce in its file for every visitor, so it uses script hashes instead. See [Prerendered headers](#prerendered-headers).

```ts
createServer({
	plugins: [
		...defaultPlugins(),
		cspNonce({
			policy: (nonce) =>
				`script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none'`,
		}),
	],
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

After a deploy, an open tab still runs the old build. When the visitor goes to a new route, the browser asks for an old chunk, such as `/assets/route-3f9a1c.js`. The new server does not have it, so the navigation fails. Keep the old `/assets/*` files at the CDN or in the image for 7 days after a deploy. Then the old tab keeps working. The server sends `Cache-Control: no-store` with a missing asset, so a CDN does not keep the 404. `buildId()` sends the deployed build on each document and data response. The app's client code can compare it with its own build, and load the next page as a document after a change.

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

`noindex()` sets `X-Robots-Tag: noindex, nofollow` on each response, so a search engine does not index a preview deploy. Turn it on from the environment:

```ts
defaultPlugins({ beforeStatic: process.env.PREVIEW === "1" ? [noindex()] : [] });
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

### A prerendered markdown twin

When the build prerenders a markdown twin for each page, such as `/components/button.md` for `/components/button`, turn on `markdownTwins`:

```ts
createServer({ plugins: defaultPlugins({ prerendered: { markdownTwins: true } }) });
```

- A request that `prefersMarkdown` accepts gets the twin, with the twin's captured headers.
- Each answer for a page with a twin gets `Vary: Accept`: the twin, the prerendered HTML, and the framework's answer for a rendered page. The server adds `Accept` to the `Vary` values that are already there.
- A page with no twin, and the twin's own URL, get no `Vary: Accept`.

The default twin is the path with no trailing slash plus `.md`, and `/index.md` for `/`. A different mapping goes in `twinOf`. Its path follows the same rules as a request path:

```ts
prerendered({ markdownTwins: { twinOf: (path) => (path === "/" ? "/llms.md" : `${path}.md`) } });
```

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

A request with a valid W3C `traceparent` header logs `trace_id` and `span_id` on each line. `requestId({ datadogTraceIds: true })` also logs `dd.trace_id` and `dd.span_id`, the lower 64 bits in decimal, so Datadog connects each line to its trace.

`accessLog({ attributes })` adds the app's own attributes to each request line. `accessLog({ serverTiming: true })` sets `Server-Timing: app;dur=<ms>` on each HTML document: the time until the response headers were ready.

```ts
defaultPlugins({
	requestId: { datadogTraceIds: true },
	accessLog: { attributes: (c) => ({ "usr.id": c.get("userId") }) },
});
```

## Health checks

`health()` answers `/livez` and `/readyz` with `Cache-Control: no-store`. `/livez` always answers 200. `/readyz` answers 200 until the server gets a stop signal, then 503. `ready` adds an app check, such as a database ping. When the check starts to fail, one warn line goes to the log, and when it passes again, one info line. A stop signal during the check also gives 503. Put the plugin first, so a probe skips the access log:

```ts
export default createServer({
	plugins: [health({ ready: async () => db.ping() }), ...defaultPlugins()],
	shutdownDelayMs: 5_000,
});
```

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
- `HostRuntime` (from `@ngrok/app-server`): the client build's files, the default listeners, request storage for `requestContext()`, a gzip stream, and a lifecycle for a long-lived process. The run-side module exports `host`. `files(...).open(path, range)` must honor `range`, because the static stages send those bytes in a 206.

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
- One server process uses one CPU core. To use more cores, run one replica or one container for each core behind the load balancer.
- The package has one host adapter, `node`. A serverless host, such as Cloudflare Workers or Vercel, needs its own adapter. See `HostRuntime` and `HostBuild`.
- On Deno, `Deno.serve` logs a notice about its legacy `request.signal` behavior.
