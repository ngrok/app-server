# @ngrok/app-server

A composable [Hono](https://hono.dev) app server for [React Router](https://reactrouter.com) and [TanStack Start](https://tanstack.com/start) apps. It replaces `@react-router/serve`, and it runs the same request pipeline in development and production, on Node, Bun, and Deno, or as a Vercel Function.

## Compared with `@react-router/serve`

`@react-router/serve` 8.5.1 is Express 5 with `compression()`, `express.static` for the client build, and a `morgan` text log that comes after the static files. `app-server` serves the same build faster. It also does more work for each request.

### Speed

On the React Router fixture app of this repo, `app-server` answers more requests each second than `@react-router/serve` on each route:

| Route                                               | `app-server` | `@react-router/serve` | Change |
| --------------------------------------------------- | -----------: | --------------------: | -----: |
| `/`, a prerendered page                             |       27,353 |                17,611 |   +55% |
| `/ssr`, a rendered page                             |        5,648 |                 2,401 |   2.4× |
| `/assets/*.js`, 233 kilobytes (KB), 68 KB as brotli |       22,491 |                 2,006 |    11× |
| `/hello.txt`, a prerendered file of 5 bytes         |       29,131 |                22,278 |   +31% |

The table gives requests per second for a client that sends `Accept-Encoding: gzip, deflate, br`, as a browser does. Most of the large gains come from compression. `compression()` compresses each response with brotli for each request, and `app-server` sends the copy that the build wrote.

With no `Accept-Encoding`, the gains are +17% for `/`, +15% for `/ssr`, +31% for `/assets/*.js`, and +23% for `/hello.txt`. In these numbers, `app-server` also adds the security headers, a request ID, a JSON log line, and the build ID to each response.

A CDN that keeps the `/assets/*` files makes the asset gain smaller for a visitor.

How we measured:

- Build the package with `pnpm run build`, then build `test/fixtures/react-router` with `react-router build`.
- In that directory, run `node build/server/app-server.js` and `pnpm exec react-router-serve build/server/index.js`, with `NODE_ENV=production`. Each server is one process. `pnpm install` installs `@react-router/serve` as a development dependency of this repo.
- Send load to each route with `oha -z 5s -c 64`: 64 connections for 5 seconds. Use `--disable-compression` for the runs with no `Accept-Encoding`.
- The table gives the median of 5 rounds. The two servers alternate in each round, and `app-server` got more requests each second in each round.
- The versions are Node.js 26.13, `@react-router/serve` 8.5.1, Express 5.3.0, `compression` 1.8.2, and `oha` 1.16.0. The machine is one Apple M3 Max with macOS.

### What it fixes

- Each page has one URL. A page URL with the other trailing-slash form gets a 308 to it, for rendered and prerendered pages. A prerendered page answers at its own URL with a 200.
- A prerendered resource route (`llms.txt`, `sitemap.xml`, a JSON API file) and each `.data` file keep the headers their loader sent: `Content-Type`, `Cache-Control`, CORS.
- A static file gets the brotli or gzip copy that the build wrote. `compression()` compresses each response again for each request.
- A streamed page under brotli or gzip reaches the client chunk by chunk.
- Each request gets one JSON log line in your format, static files included, and an `X-Request-Id`.
- Shutdown drains open requests with a deadline, and the keep-alive timeout outlasts the proxy's idle pool. `@react-router/serve` closes the server on `SIGTERM`, with no deadline and no readiness probe.

### What it adds

For a marketing site:

- [Redirects](#redirects) from a table, and [`noindex`](#preview-deploys) for preview deploys.
- [Markdown twins](#content-negotiation) for agents, with `Vary: Accept` and a `Link` header.
- [Security headers](#security-headers), and [a CSP for each document](#a-csp-for-each-document): script hashes for a prerendered page and a nonce for a rendered page.
- ETags, 304s, and byte ranges for each static file, so Safari plays a `<video>` from the client build.
- [One build for each environment](#environment): the `PUBLIC_` values go into each HTML document at serve time.

For a web app:

- [Deploys and open tabs](#deploys-and-open-tabs): after a deploy, the next navigation of an old tab loads its target as a document, so the old code never renders new data. The client module adds no request to a client navigation.
- [Health checks](#health-checks) at `/livez` and `/readyz`, and a delay before the drain.
- A [request body limit](#the-pipeline), and [`Cache-Control: private`](#the-pipeline) on each rendered page and data response with no `Cache-Control`, so a shared cache never keeps them for one user.
- [Logs](#logs) with W3C and Datadog trace IDs, a logger in each loader, and the client address behind a proxy.
- [Server-sent events](#long-lived-responses) that close at shutdown.
- An auth check that also protects each prerendered file. See [Protect pages](#protect-pages).

For each app:

- One pipeline for development and production, with the same headers and the same CSP.
- A [server build that runs with no install](#deploy), on Node.js, Bun, or Deno, or as a [Vercel Function](#deploy-to-vercel).

### What changes for your app

- The app needs Node.js 26, Vite 8.3+, and React Router 8.5+. See [Requirements](#requirements).
- The package has ES modules only.
- A plugin holds Hono middleware, not Express middleware.
- With `defaultPlugins()`, a request body over 10 mebibytes (MiB) gets a 413, and a page URL with a trailing slash gets a 308. Change both with the options of `defaultPlugins()`.
- The package does not support React Router `serverBundles`, and the app must serve at `/`. See [Limits](#limits).

## Requirements

- Node.js 26, Bun 1.3+, or Deno 2.9+
- Hono 4.13.16+
- Vite 8.3+
- React Router 8.5+, or TanStack Start 1.169+
- An ES module app and server build. The package has no CommonJS build, and the Vite plugin refuses a CommonJS server build.

## Install

```sh
pnpm add -E @ngrok/app-server hono
```

Hono is a peer dependency, so the app and the package share one copy of it. A middleware of the app's Hono, such as `cors()` from `hono/cors`, then fits the `middleware` of a plugin.

## Set up

The server has three layers:

- The core: the request pipeline, the plugins, and `createServer`. It imports Hono and nothing else.
- A framework adapter: how the framework renders a request. `react-router` and `tanstack-start` come with the package.
- A host adapter: where the server runs. `node` and `vercel` come with the package. `node` runs one long-lived process on Node, Bun, or Deno, such as in a Docker image. `vercel` runs the pipeline in one Vercel Function. See [Deploy to Vercel](#deploy-to-vercel).

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

`appServer` has four options. Each one has a default:

- `framework`: the framework adapter. Default: the adapter of the framework plugin in the Vite config. The plugin of React Router is `reactRouter()`, and the plugin of TanStack Start is `tanstackStart()`. If the config has neither plugin or both, Vite stops with an error. Then pass `reactRouterAdapter()` from `@ngrok/app-server/react-router/vite` or `tanstackStartAdapter()` from `@ngrok/app-server/tanstack-start/vite`.
- `host`: the host adapter. Default: `node()` from `@ngrok/app-server/node/vite`.
- `app`: the module whose default export is the app, relative to the Vite root. Default: `server.ts`, else `server.js`, in the Vite root. If neither file exists, the server uses the default plugins.
- `externals`: how the server build copies the packages that stay external. `whole` lists packages that keep each file, and `omit` lists packages that the build does not copy. Default: no package in either list. See [Deploy](#deploy).

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

After the build and after the prerender pass, `appServer` writes a gzip copy (`.<file>.gz`) and a brotli copy (`.<file>.br`) next to each compressible file of 1 kibibyte (KiB) or more in the client build, HTML pages included. A compressible file has a text type, a type with a `+json` or `+xml` suffix (such as an RSS feed), or another type that compresses well: JSON, JavaScript, WebAssembly, YAML, a shell script, an icon (`.ico`, `.bmp`), or a TrueType, OpenType, or Embedded OpenType font. A WOFF or WOFF2 font is compressed already, so it gets no copy. The build reads the type of a file from its extension, with the content types of the framework adapter. So a React Router `.data` file, which the server sends as `text/x-script`, gets its copies. The build does not read the `Content-Type` that the prerender pass recorded, so give a prerendered resource a file extension, such as `/feed.xml`, to get its copies. It writes the gzip copy when it is smaller than the file, and the brotli copy when it is smaller than the gzip copy. A host can ask for fewer copies: on the `vercel` host, the build writes only the brotli copy, when it is smaller than the file, and no copy of a file that the CDN serves. `app-server serve` sends the copy that the client's `Accept-Encoding` prefers, brotli before gzip, so it does not compress the file for each request. Each copy is a dotfile, so it has no URL of its own: a `skip` rule or an auth check for the file also blocks its copies. The build does not change a `.gz` or `.br` file of the app. A link, and a file in a linked directory, get no copy, so the build writes only inside the client build. The copies include the prerendered files, in any plugin order. With `appServer` after the framework's plugin, as in the examples above, the build writes the copies one time, after the prerender pass. With `appServer` first, the build writes the copies before the pass, and then the copies of the files that the pass changed. The brotli copies use quality 9, not 11: on a docs build with 70 megabytes (MB) of text, quality 11 adds 46 s to the build, and quality 9 adds 0.6 s for copies that are 9% larger. `appServer` gives a list of Vite plugins, so put it in `plugins` as it is.

The build exports `appServer`, and the CLI calls it. So the copy of this package in the build runs the server, and the CLI's copy runs nothing. The CLI refuses a build from a version of this package with another entry protocol.

A React Router app with no Vite plugin also works: `app-server serve build/server/index.js` reads a plain React Router build and runs it with the CLI's copy, the node host, and the default plugins. In that build, a route that calls `shutdownSignal()`, `eventStream()`, `requestContext()`, `logger()`, or `cspNonce()`, or that reads `appServerContext`, must import the CLI's copy, so do not bundle `@ngrok/app-server` into it.

## Commands

- `app-server start`: development. Vite in middleware mode inside the pipeline, with HMR on the same port. It needs the `appServer` plugin. Each request loads the latest server entry, so an edit to a route or to `server.ts` applies at once. A Vite plugin gets the CLI's HTTP server as `server.httpServer` in its `configureServer` hook, so it can wait for `listening` and `close`. A Vite restart, such as after an edit to `vite.config.ts`, keeps that server open. So a new plugin instance gets no `listening`, and the old instance gets `close` only at exit. To clean up for each instance, use Vite's `closeServer` hook. The port is `--port`, else `PORT`, else Vite's `server.port`. When that port is in use, `start` tries each next port, unless Vite's `server.strictPort` is true. The host is `HOST`, else Vite's `server.host`. When it listens, `start` prints its URLs as `vite dev` does, through Vite's logger. Its other log lines, such as a port in use, use the text format of Go's `log/slog`, not JSON. On `SIGTERM` or `SIGINT`, it stops Vite and the server, then exits.
- `node build/server/app-server.js`: production, with no install. Use `dist/server/app-server.js` for TanStack Start. It reads `PORT` and `HOST`, and it drains on `SIGTERM`, on `SIGINT`, and after an uncaught error, as `app-server serve` does. It has no `--port`. It sets `NODE_ENV` to `production` when `NODE_ENV` has no value.
- `app-server serve [path]`: production. With no path, it runs the first of `build/server/app-server.js` (React Router), `dist/server/app-server.js` (TanStack Start), and `build/server/index.js` (a plain React Router build). The port is `--port`, else `PORT`, else 3000. The host is `HOST`, else every interface. A `port` or a `host` that the app gives to `tcp()` wins over them, with no message, so leave both out of `tcp()` to let the operator choose. A port in use stops startup at once. On `SIGTERM` or `SIGINT`, it drains, then exits, even when the app left a timer. After an uncaught error, it logs the error, drains, then exits with code 1. A server process serves the client build that was there at start. A deploy starts a new process.

`-p` is short for `--port`. `--help`, or `-h`, writes the usage. A bad argument writes a message and the usage, and exits with code 1.

On Bun, run `bun build/server/app-server.js`, or `bun node_modules/@ngrok/app-server/dist/cli.js serve`. On Deno, run `deno run --allow-net --allow-env --allow-read --allow-sys build/server/app-server.js`, or give the same flags to `node_modules/@ngrok/app-server/dist/cli.js serve`. A native package on Deno also needs `--allow-ffi`. For `start` on Deno, also give `--allow-ffi --allow-write --ignore-read=/proc/sys/fs/binfmt_misc/WSLInterop`. Vite loads its native bundler and writes its cache. On Linux, Vite also reads a WSL file that Deno gives only to `--allow-all`.

## Deploy

`vite build`, or `react-router build`, writes a server build that runs with no `npm install`. Copy the build directory alone, and run its server entry:

- `appServer` bundles each dependency into the server build. For the build, it sets `ssr.noExternal: true`, unless the app sets its own `ssr.noExternal` or sets `ssr.external: true`.
- Some packages stay external: each package in the app's `ssr.external` or in the bundler's `external` option, the whole package of an external subpath, each peer dependency of a package that the app keeps external, the peers of each peer, each native package, and each package that reads a file next to its own module. So the bundle and an external package use one copy of a package, such as `react` for a component library. For a `RegExp` or a function in the bundler's `external` option, the build tests the name of each package in the `dependencies`, `optionalDependencies`, and `devDependencies` of the app. It keeps the peers of each match external too. A package is native when a `.node` file is in it, or in a package of its `dependencies` or `optionalDependencies`. For example, `oxc-parser` gets its addon from `@oxc-parser/binding-linux-x64-gnu`. A package reads a file next to its module when the file that an import resolves to has `new URL("./…", import.meta.url)`, `fileURLToPath(import.meta.url)`, `import.meta.dirname`, or `import.meta.filename`. For example, `@vercel/og` reads `resvg.wasm` so.
- The build copies each external package, with its installed dependencies, into `node_modules` in the server build. Each file stays where its package expects it, so CommonJS, a file read through `__dirname`, and a `.node` addon work.
- The build then removes each copied file that the server build cannot load, as [`@vercel/nft`](https://github.com/vercel/nft) traces it from the modules of the build, with the export conditions of Node, Bun, and Deno. So a source map, an edge build, or a dependency that a package bundled into its own file does not reach the deploy. For `@vercel/og` 1.0.1, the copy goes from 42.9 MB in 453 files to 23.6 MB. Five kinds of package keep each file: a native package and each package that it depends on (a native package can load a library, such as libvips, that a trace cannot see), each package in `ssr.external`, each package that the app gives to `require.resolve()` or `import.meta.resolve()`, each package that the trace misses files of, with each package that it depends on, and each package in `externals.whole`. The trace misses files of a package when its loaded code has `import.meta.dirname` or `import.meta.filename`, or when it cannot parse a loaded module, such as a TypeScript entry for Bun. It also misses a file that a loaded module gives to `require.resolve()` or `import.meta.resolve()` through the `exports` of a package, so that package keeps each file too. Add a package to `externals.whole` when it reads a file whose path the trace cannot find.
- The build does not copy a package in `externals.omit`. Use it for an optional dependency that a package loads in a `try`. For example, `@vercel/og` uses `sharp` when it is installed, else `resvg.wasm`. `appServer({ externals: { omit: ["sharp"] } })` makes the `@vercel/og` copy 3.0 MB. The server fails when it loads an omitted package with no `try`.
- The build copies each package in `ssr.external`, also when no code imports it. It also copies each package that the app's code gives to `require.resolve()` or `import.meta.resolve()` as a string, such as `require.resolve("@fontsource/inter/files/inter-latin-400-normal.woff")`. When the code makes the name at run time, add the package to `ssr.external`.
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

## Deploy to Vercel

The `vercel` host runs the pipeline in one Node.js Vercel Function. Vercel's content delivery network (CDN) serves the hashed files, and with `cdnPages`, each public prerendered page.

Use `vercel()` as the host:

```ts
// vite.config.ts
import { vercel } from "@ngrok/app-server/vercel/vite";

appServer({ host: vercel() });
```

After the build, `vercel()` writes `.vercel/output` (the Build Output API, version 3) in the Vite root. Deploy it with `vercel deploy --prebuilt`. Do not add `vercelPreset()` from `@vercel/react-router`. To build one app for Docker and for Vercel, choose the host from an environment variable, such as `appServer(process.env.VERCEL === "1" ? { host: vercel() } : {})`.

The output has two parts:

- `static/`: the files of Vite's `build.assetsDir` (`/assets/` by default), the other `cdnPaths`, and with `cdnPages`, the public prerendered pages. The CDN serves them. Each file of `build.assetsDir` gets `Cache-Control: public, max-age=31536000, immutable`. A request under `build.assetsDir` with no file goes to the function, which sends a 404 with `Cache-Control: no-store`. A request under another CDN path with no file goes through the pipeline, as on the node host.
- `functions/index.func/`: the function for each other request. It has the whole server build, which runs with no install (see [Deploy](#deploy)), and the rest of the client build. The Node.js version of the function is the version that ran the build.

### Prerendered pages on the CDN

By default, the function serves each prerendered page, so a page gets the same pipeline as a rendered page. To let the CDN keep a page, send `s-maxage` or `CDN-Cache-Control` in its headers, such as with the `headers` option of [`prerendered`](#prerendered-headers). Then a page calls the function only on a CDN miss.

With `vercel({ cdnPages: true })`, the CDN serves each public prerendered page with no function. After the build, `vercel()` starts the server build once, with no listener, and sends each prerendered path through the pipeline. The first request comes from an anonymous client, with no cookie and no `Authorization`. The CDN serves a page when its answer meets all of these conditions:

- It is a 200 from the page's file.
- It has no `Set-Cookie`. It has no `private`, `no-store`, or `no-cache`, in any case, in `Cache-Control` or in a CDN field such as `Vercel-CDN-Cache-Control`.
- It is the same for a second client with another host, client address, user agent, query, `Accept` with no markdown, and value of the `unlessHeader` header. The second client also sends a cookie, `Authorization`, `Referer`, `Accept-Language`, and Vercel's `X-Vercel-IP-Country`, `X-Vercel-IP-Country-Region`, and `X-Vercel-IP-City`. So a plugin that sends a signed-in visitor or a country to another answer keeps its pages in the function. Only the request ID header of `requestId()` and `Date` can change.
- It varies only on `Accept-Encoding`, on `Accept` for a [markdown twin](#content-negotiation), and on the header of `noindex: { unlessHeader }`.

The CDN then sends the pipeline's body and headers: the security headers, the CSP, the build ID, and the `runtimeEnv` values. The function also keeps the page's file, for a request that no CDN route matches, such as `/about/` for `/about`. A browser gets `Cache-Control: public, max-age=0, must-revalidate` and the CDN's ETag, so it revalidates each page. Vercel keeps the CDN's copies for one deployment, so a deploy never serves an old page. The build log names each path that the function serves, with the reason. The report goes through the logger of the Vite build at the `info` level, so Vite's `logLevel` and `customLogger` apply to it. With `appServer` before the framework's plugin, the build prints the report two times, and the report after the prerender pass is the correct one.

The function serves each other prerendered page, and the CDN never keeps its answer:

- A page that an auth check in `beforeStatic` protects stays in the function, because the check refuses the anonymous request. So the CDN never keeps a page behind auth.
- A page whose answer changes with the query or the host stays in the function, such as with a `prerendered({ rewrite })` that reads the query.
- A request that names `text/markdown` in `Accept` goes to the function, which negotiates the twin.
- Vercel allows 2,048 routes for each deployment. A page uses one route for each case of the `unlessHeader` header, and one more for a twin. If the pages need more routes, the function serves the rest.
- A page with a `$` in a response header stays in the function, because a Vercel route reads `$1` or `$name` in a header as a capture.
- A request with another method, such as a form's `POST`, goes to the function.

The build cannot see a check that both clients pass but another client fails, such as a check of a real session, an allowlist of client addresses, or a rule on one query key. Keep such a page in the function with a `cdnPages` function. A page that the CDN serves writes no access log line, and neither do the build's requests. The build also needs the app's environment, because it runs each plugin's `setup`.

`vercel()` takes:

- `cdnPaths`: more URL path prefixes for the CDN, such as `["/blog-assets/"]`. Each starts and ends with `/`. Their files skip the pipeline, and the function does not carry them. Vercel limits a function to 250 MB, so put a large directory of the client build here. Default none.
- `cdnHeaders`: headers for each file of `cdnPaths` and `build.assetsDir`, such as CORS headers. Default none.
- `cdnPages`: which prerendered pages the CDN can serve. `true` gives the CDN each page that qualifies. A function gives the CDN each page that qualifies and that it accepts, such as `(path) => path !== "/"` for a page that renders a filtered view for one query key. A page that it refuses in either trailing-slash form stays in the function. Default `false`: the function serves each page.
- `regions`, `memory`, and `maxDuration`: the function's Vercel config. Default the project's. One function serves each route, so the values apply to each request. A route module's `config` export, such as `export const config = { maxDuration: 60 }` for `@vercel/react-router`, does nothing.

The function differs from a long-lived process:

- Vercel starts and stops it. Each plugin's `setup` runs on the first request of each instance. If a `setup` throws, that request fails, and the next request runs each `setup` again. `onShutdown` never runs, and `shutdownSignal()` never aborts.
- The request scheme comes from `X-Forwarded-Proto`, and the client address comes from `X-Real-IP`, because Vercel sets both headers. Do not set `trustForwardedProto` or `trustedProxyHops`. Behind another proxy, such as the ngrok edge, the client address is the proxy's.
- The function does not compress a response, because the CDN compresses each response.
- The function keeps only the brotli copy of a file that has one, so it holds one copy of each text file, not three. For a blog with 265 prerendered pages, that makes the function about 50 MB smaller. A client that accepts brotli, as each browser does, gets the copy. For any other client, the function decompresses the copy, and the CDN compresses the response. The build writes only the copies that the deploy holds, so `build/client` has no gzip copy, and no copy of a file under `cdnPaths` or Vite's `build.assetsDir`.
- The deploy gives each file of the function one fixed modification time. So the function uses the time of the build for each file, and the ETag of each file it sends changes with each build.
- `app-server serve` cannot run the build. Use `app-server start` for development, as with the node host.

## The pipeline

`createServer` runs the plugins in list order, then the app's own Hono routes, then the framework. `defaultPlugins()` returns this order:

1. `health()`: the liveness and readiness probes at `/livez` and `/readyz`. A probe skips the access log. `defaultPlugins({ health })` changes them, and `false` turns them off. See [Health checks](#health-checks).
2. `requestId()`: reuses a valid incoming `X-Request-Id`, else makes a UUID, and echoes it. `defaultPlugins({ requestId: { headerName } })` uses another header. A name that is not an HTTP header name stops startup.
3. `accessLog({ redactQuery })`: one line per request when the response ends, for the response that leaves the server, with Datadog standard attributes (`http.status_code`, `network.bytes_written`, `duration` in nanoseconds). Query values are `REDACTED` by default. A 5xx line has the level `error`, and each other line has the level `info`. With React Router, a line for a request that React Router answers has the route pattern that it matched as `http.route`, such as `/domains/:domainId`. A prerendered page that the server sends from its file has no `http.route`. In development, a request that Vite answers, such as a source module or `/@vite/client`, gets no line. A request of the `vercel` build's check of the CDN pages gets no line.
4. `streamingCompress()`: brotli or gzip that flushes after each chunk. A client gets brotli, at quality 4, when its `Accept-Encoding` ranks `br` at least as high as `gzip`. For HTML, brotli at quality 4 is smaller than gzip, for the same CPU time. For example, a page of 149 KiB in 10 chunks takes 0.60 ms and 7.7 KiB as brotli, and 0.68 ms and 10.6 KiB as gzip, on an Apple M3 Max. The `compression` middleware of Express also uses quality 4. On the node host, brotli holds the start of a body to pick its window. A body that ends within 256 KiB gets a window of 256 KiB, in one zlib call. A longer body gets the default window of 4 MiB, so it can use a repeat that is more than 256 KiB back. Why not 4 MiB for each body: Node.js tells V8 the full window of each open encoder, and under load V8 then runs a full garbage collection for every few responses. When the body waits for its next chunk first, for one turn of the event loop, the stream sends what it holds with the 256 KiB window. So a page shell that waits for slow data, such as a React `<Suspense>` boundary, still goes out at once. Chunks that the body has queued together go out as one, up to 64 KiB, so a rendered page costs fewer flushes. For example, a rendered page of 19 KB that the body queues at once costs one zlib call, not three. When the body ends by the time the stream finishes its last chunk, that chunk and the end of the stream go out together. On the node host, a body that ends with its first chunk, up to 64 KiB for gzip and 256 KiB for brotli, uses a zlib stream from a pool, so a small page costs no new zlib stream. Each encoding keeps up to 16 streams between responses. The gzip streams hold about 4.3 MiB in all. A gzip stream takes only such a body, and only one at least as long as each earlier body of that stream, so the gzip bytes of a body depend on that body alone. A reset gives a brotli stream a new encoder, so its bytes also depend on the body alone. On Bun and Deno, each brotli body gets a new stream, because a reset there loses the quality or gives no bytes. It skips encoded, partial, and `no-transform` responses, and a body under 1,024 bytes: by its `Content-Length`, or a body from a string. It adds `Accept-Encoding` to `Vary` only on a compressible type, the same types that get a copy from the build. A static file with a compressed copy from the build gets that copy, and this plugin skips it. It follows the `q` values of `Accept-Encoding`, and `q=0` refuses an encoding. The host gives the streams. On a host with neither, the plugin does nothing.
5. `securityHeaders()`: safe default security headers on each response, prerendered pages included. `defaultPlugins({ securityHeaders })` changes them, and `false` turns them off. See [Security headers](#security-headers).
6. `bodyLimit({ maxBytes })`: a 413 for a request body over `defaultPlugins({ bodyLimit })`, 10 mebibytes (MiB) by default. `false` turns it off. A `Content-Length` that is too large gets the 413 before the app runs. A streamed body errors when it passes the limit. When the app reads the body before it answers, the response becomes a 413. When the app streams the body into its response, the response stream errors. A `bodyLimit` that is not a whole number of 0 or more stops startup. The body streams. The plugin does not read it into memory.
7. The plugins of the named options. They see every response, prerendered pages included:
   - `noindex()`, with `defaultPlugins({ noindex })`. See [Preview deploys](#preview-deploys).
   - `buildId()`, on by default. `defaultPlugins({ buildId })` changes it, and `false` turns it off. See [Deploys and open tabs](#deploys-and-open-tabs).
   - `contentSecurityPolicy()`, with `defaultPlugins({ contentSecurityPolicy })`. See [A CSP for each document](#a-csp-for-each-document).
   - The plugin from `runtimeEnv()`, with `defaultPlugins({ env })`. See [Environment](#environment).
8. The `beforeStatic` plugins: the app's own plugins that see every response, prerendered pages included, such as an auth check. They come after the plugins of the named options, so they get the CSP nonce, and their responses get the headers of those plugins.
9. `assets()`: the files of Vite's `build.assetsDir` (`/assets/*` by default) with a one-year immutable cache. The `appServer` Vite plugin records the directory in `.app-server.json`. A missing asset gets a plain 404 with `Cache-Control: no-store`. In development, Vite serves here. See [Deploys and open tabs](#deploys-and-open-tabs).
10. `redirects(rules)`, when `defaultPlugins({ redirects })` has rules: a redirect from each old URL to its new URL. See [Redirects](#redirects).
11. `trailingSlash({ mode })`: a 308 from a page URL to the same URL in the site's trailing-slash form. See [Trailing slashes](#trailing-slashes).
12. `prerendered({ headers, rewrite, skip, cacheControl })`: every file in the client build, with its content type, an ETag, a 304 for a matching `If-None-Match`, and a 206 for one byte range of a file that is not HTML. A range that starts after the end of the file gets a 416. A request with `If-Range` gets the full file, because the ETag is weak. An HTML page, a markdown file, and a data file of the framework get `Cache-Control: public, max-age=0, must-revalidate`, and every other file gets `public, max-age=3600, stale-while-revalidate=86400`. A captured header, the `headers` option, and `cacheControl` change it. When `cacheControl` gives `undefined` for a file, the file keeps this default. `skip` and `rewrite` get the request path, such as `/about`. `headers` gets `path`, the path that names the file after `rewrite` and a markdown twin, and `file`, the path of the file, such as `/about/index.html`. `cacheControl` gets the path of the file. A file with a compressed copy from the build gets `Vary: Accept-Encoding`. A client gets the copy that its `Accept-Encoding` prefers, brotli before gzip, with no byte ranges and an ETag for that encoding. A `no-transform` response never gets a copy, and an HTML page gets none when `runtimeEnv` adds values to it. A directory answers with its `index.html`. Each file has one URL: `/a//b`, `/a/index.html`, and `/a%2Fb` go on to the framework. Dotfiles stay private, except `/.well-known/`. A path with no file, or a path that `skip` matches, goes on to the framework. The content type comes from the file's extension. Besides the types that Hono knows, `.sh` gets `application/x-sh`, `.yaml` and `.yml` get `text/yaml`, `.rss` gets `application/rss+xml`, `.atom` gets `application/atom+xml`, and `.pem` gets `application/x-pem-file`, as with `express.static`. An unknown extension gets `application/octet-stream`.
13. `privateDocuments()`: `Cache-Control: private, no-cache` on each HTML document and each framework data response (such as a React Router `.data` request) from the app's routes or the framework that has no `Cache-Control`. A shared cache then never keeps a page or loader data that the server rendered for one user. A response with its own `Cache-Control` keeps it. A resource route that sends per-user JSON sets its own `Cache-Control`.

A route that takes a body larger than the limit needs a higher `bodyLimit` for the whole app, because each request passes the limit before it reaches a route.

The options `requestId`, `accessLog`, and `prerendered` of `defaultPlugins()` take the options of the plugin of the same name, and `trailingSlash` takes the mode.

`defaultPlugins()` is a plain array, so you can filter it or splice into it. To find a plugin in the array, compare its `name`. The names, in the order of the list, are `health`, `request-id`, `access-log`, `streaming-compress`, `security-headers`, `body-limit`, `noindex`, `build-id`, `content-security-policy`, `runtime-env`, `assets`, `redirects`, `trailing-slash`, `prerendered`, and `private-documents`. A filter on a name that no plugin has removes nothing, with no error. For example, behind a proxy that compresses each response, remove the compression of the server:

```ts
createServer({
	plugins: defaultPlugins().filter((plugin) => plugin.name !== "streaming-compress"),
});
```

Keep `assets` in the array, because it runs Vite in development.

Two plugins of one option of `defaultPlugins()`, such as `defaultPlugins()` with a second `bodyLimit()`, stop startup. The check covers the plugins of the options `health`, `requestId`, `accessLog`, `securityHeaders`, `bodyLimit`, `noindex`, `buildId`, `contentSecurityPolicy`, `env`, `trailingSlash`, and `prerendered`. It does not cover `redirects()`, because a second table is valid. Two copies do not act as one: a value that the app gave is lost, or both act, such as two trailing-slash redirects that loop. Use the option. To put your own copy at another place, turn the option off with `false`, as `health`, `securityHeaders`, `bodyLimit`, and `buildId` allow, or filter the default out of the list by its `name`.

A plugin of the options `securityHeaders`, `noindex`, `buildId`, `contentSecurityPolicy`, or `env` that comes after `prerendered()` in the list also stops startup, because the prerendered pages would not get it. Use the option, or put the plugin before `prerendered()`, such as in `beforeStatic`.

A plugin is an object with a `name`, an optional Hono `middleware`, and optional hooks:

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

A function is not a plugin. To use a Hono middleware, such as `basicAuth()` from `hono/basic-auth`, put it in a plugin:

```ts
import { basicAuth } from "hono/basic-auth";

const auth: Plugin = { name: "basic-auth", middleware: basicAuth({ username, password }) };
```

`createServer` stops startup for an entry of the plugin list that is not a plugin, with an error that names the entry and the fix. The `Plugin` type also rejects each of these entries:

- A function: a Hono middleware with no plugin around it, or a plugin factory that the app did not call, such as `requestId` in place of `requestId()`.
- A list: a list of plugins with no spread, such as `defaultPlugins()` in place of `...defaultPlugins()`.
- A promise: the result of an `async` plugin factory with no `await`.
- A value that is not an object, such as `false` from `condition && plugin`. To add a plugin on a condition, spread a list: `...(condition ? [plugin] : [])`.

A `middleware` returns a `Response`, or it calls `await next()`. If a middleware returns no `Response` and does not call `await next()`, the request has no answer. The client then gets the answer of the app's `onError`. The default `onError` answers a 500 and writes an `unhandled error` line to the log. Each host gives this answer, and so does `createTestServer`.

The app's `onError` must return a `Response` for each error. If it returns none, such as from a handler with no last `return`, the client gets a 500, and the log gets an `unhandled error` line that names the handler. That line has the error in its `error.cause.*` fields.

At shutdown, the server runs each `onShutdown` at the same time. When one throws, the server logs `plugin shutdown failed` with the error and the name of the plugin as `app_server.plugin`. When one is still open at the drain deadline, the server logs `plugin shutdown passed the deadline` with the names of the open plugins as `app_server.plugins`, and stops waiting.

A plugin that sets a header on the response uses `withHeaderHook`. The hook changes the head once, where the response leaves, after the later stages and after the code that each stage runs after `await next()`. The hook of an inner stage runs first, so an outer stage has the last word. On Node.js and Vercel, the hooks change the list of headers that the server writes, so the response needs no copy. So code after `await next()` sees the response of the later stages without the changes of their hooks. To read or change the final headers, use a hook. A hook can read `requestContext()`. A hook that throws gets the answer of the app's `onError`, as a stage that throws does. On Node.js and Vercel, a wrapper of the app's `fetch` gets the response before the hooks: a header that it sets or deletes goes out, but it does not see the headers that the hooks set. In development, Vite answers some requests itself, such as source modules and `public/` files, and sends the response before the earlier stages get it back. The hooks also run on those responses, before Vite sends the head, so each response gets the same headers in development and in production. The static stages and `streamingCompress()` also run the hooks on a view of the headers before they choose a body, so a `no-transform`, a `Content-Encoding`, or a `Content-Range` from a hook keeps the body as it is. So a hook runs two or three times for a response that `streamingCompress()` compresses or that has a compressed copy. Each run must give the same headers, and a hook must do nothing else, such as log, count, or store a value. A view run can come before the code that a stage runs after `await next()`, and a throw in it changes nothing. A hook can `get`, `has`, `set`, `append`, and `delete` a header.

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

A plugin can keep its own value on the Hono context, such as the ID of the user. For TypeScript, declare the value one time, in a module such as `server.ts`. `c.set("userId", …)` and `c.get("userId")` then type-check in each plugin, each route, and each option callback. The declaration needs the one copy of Hono of [Install](#install).

```ts
// server.ts
declare module "hono" {
	interface ContextVariableMap {
		userId: string;
	}
}
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
		if (!c.req.path.toLowerCase().startsWith("/app")) {
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

`hasSession` stands for the app's own session check. The plugin compares the lowercase path, because React Router and TanStack Router match a path in any letter case: without it, `/APP/settings` passes the check, and the framework renders the page. The plugin protects only the paths that it names, so also keep a session check in each loader that reads private data.

## Security headers

`defaultPlugins()` runs `securityHeaders()`. It sets these headers on each response, prerendered pages included:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Cross-Origin-Opener-Policy: same-origin`
- `Strict-Transport-Security: max-age=31536000`, on an HTTPS request only

`Content-Security-Policy` and `Permissions-Policy` have no default. A response that has one of these headers keeps its own value. `false` turns a header off, and `defaultPlugins({ securityHeaders: false })` turns them all off. A value that a header cannot hold, such as one with a curly quote in place of `'`, stops startup.

```ts
defaultPlugins({
	securityHeaders: {
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin-allow-popups",
			"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
			"Content-Security-Policy": "frame-ancestors 'none'",
			"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
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

In development, `app-server start` sends the same policy. A rendered page gets a nonce. An HTML file in Vite's public directory, such as `public/offline.html`, gets the hashes of its inline scripts, so a script that production blocks is blocked in development too.

```ts
createServer({
	plugins: defaultPlugins({
		contentSecurityPolicy: {
			policy: ({ scriptSrc }) => `script-src ${scriptSrc}; object-src 'none'; base-uri 'none'`,
		},
	}),
});
```

Give the nonce to the framework's render with `cspNonce()` from `@ngrok/app-server/client`. On the server, it gives the nonce of the request. In the browser, it reads the nonce from the document, so the hydration matches. It gives `undefined` when the page has no nonce. A bundler that resolves the `browser` export condition, such as Vite for the client build, gets a `cspNonce()` with no server code.

In React Router, give it to the render in `app/entry.server.tsx`:

```tsx
import { cspNonce } from "@ngrok/app-server/client";

const nonce = cspNonce();
const { pipe } = renderToPipeableStream(
	<ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
	{ nonce /* , … */ },
);
```

`<HydratedRouter>` takes no nonce, so in the browser `<Links>`, `<ScrollRestoration>`, and `<Scripts>` render no nonce, and React warns that the hydration does not match. Give them the nonce in the root `Layout`. Give it also to each inline script of the app, such as a theme script:

```tsx
// app/root.tsx
import { cspNonce } from "@ngrok/app-server/client";

export function Layout({ children }: { children: React.ReactNode }) {
	const nonce = cspNonce();
	return (
		<html lang="en">
			<head>
				<Meta />
				<Links nonce={nonce} />
			</head>
			<body>
				{children}
				<ScrollRestoration nonce={nonce} />
				<Scripts nonce={nonce} />
			</body>
		</html>
	);
}
```

In TanStack Start, give it to the router. `getRouter` runs on the server and in the browser:

```ts
import { cspNonce } from "@ngrok/app-server/client";

export function getRouter() {
	return createRouter({ routeTree, ssr: { nonce: cspNonce() } });
}
```

## Deploys and open tabs

After a deploy, an open tab still runs the old build. Two things can then go wrong:

- **Old assets.** The tab asks for a chunk of its own build, such as `/assets/route-3f9a1c.js`, and the new server does not have it. Keep the files of Vite's `build.assetsDir` (`/assets/*` by default) of each build, with their `.<file>.gz` and `.<file>.br` copies, in storage that a deploy never deletes, such as an object store behind the CDN. File names are content hashes, so the builds never collide. The server sends `Cache-Control: no-store` with a missing asset, so a CDN does not keep the 404.
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
- To send another ID, such as the image tag, set `value`. With no value, such as an unset or empty variable, the server sends the build's ID. A value that a header cannot hold, such as one with a line break, stops startup:

  ```ts
  // server.ts
  defaultPlugins({ buildId: { value: process.env.IMAGE_TAG } });
  ```

- In development, the server sends no build ID unless `value` is set, because Vite's hot module replacement (HMR) updates an open tab after each edit.
- A build with no `appServer` Vite plugin has no ID. Set `value` for it.
- `buildId()` sends the build on each document and data response, as `X-Build-Id` and in `Server-Timing`. To use another header, set `headerName` in `buildId()`, and the same `headerName` in `staleBuildReactRouter()` or `staleBuildTanStack()`. A name that is not an HTTP header name stops startup.
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
import { createServer, defaultPlugins } from "@ngrok/app-server";
import { proxy } from "hono/proxy";

const app = createServer({
	plugins: defaultPlugins({ buildId: { paths: (path) => path.startsWith("/api/") } }),
});
app.all("/api/*", (c) => {
	const { pathname, search } = new URL(c.req.url);
	return proxy(`${process.env.API_URL}${pathname}${search}`, c.req.raw);
});
export default app;
```

- Write the route with `proxy()` from `hono/proxy`, not with a plain `return fetch(url)`. `fetch` decodes the body, but it keeps the `Content-Encoding` and the `Content-Length` of the encoded bytes. The browser then gets a response that it cannot read. `proxy()` removes both headers, and `streamingCompress()` encodes the body for the client.
- The route can also be a React Router resource route. Its loader and its action return the same call: `proxy(url, request)`.
- `proxy()` sends each request header to the API, cookies and `Authorization` included. Use this form only for the app's own API. On Bun, the API also gets the `Host` header of the browser. On Node.js and Deno, it gets its own host.
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
- The first rule that matches wins. A trailing slash does not change the match. The table runs before `trailingSlash`, so `/pricing-old/` gets one redirect to `/pricing`. In the `never` mode, a local target loses its trailing slash, so `trailingSlash` does not redirect it again. A `redirects()` in your own plugin list takes the mode as `redirects(rules, { trailingSlash })`, and keeps each target as the rule has it by default.
- The rules compile at startup. A rule that is not valid stops startup. A rule matches the path only, so a `from` with a query, a fragment, or a character that is not percent-encoded is not valid: no request path can equal it. A segment of `from` that starts with `:` or has `*` must be `:name` or `*`, so `:slug*`, `(.*)`, and `*.html` are not valid. A local target must be a safe local path, and an absolute target must keep the origin that its rule names. A request whose values break either check gets no redirect.
- A request that is already at the target of its rule gets no redirect, so `{ from: "/tags/:tag", to: "/tags/:tag/" }` with `trailingSlash: "always"` does not loop.
- An exact path costs one lookup, for a table of any size. A request tests a pattern only when the pattern starts with the first segment of the request path, or with `:name` or `*`. So each request tests each rule such as `/:lang/pricing` or `/*`. Where you can, start a pattern with a literal segment.

### Preview deploys

`noindex()` sets `X-Robots-Tag: noindex, nofollow` on each response, prerendered pages included, so a search engine does not index a preview deploy. Turn it on from the environment:

```ts
defaultPlugins({ noindex: process.env.PREVIEW === "1" });
```

To allow indexing only for a request with a header, give `unlessHeader`. Each response gets the header in `Vary`, so a CDN keeps one answer for each case. An `unlessHeader` that is not an HTTP header name, such as an empty string, stops startup. For example, to allow indexing only for a request through the ngrok edge, which adds `x-ngrok-edge`:

```ts
defaultPlugins({ noindex: { unlessHeader: "x-ngrok-edge" } });
```

On the `vercel` host with `cdnPages`, the CDN serves the page and picks the answer by the header. See [Prerendered pages on the CDN](#prerendered-pages-on-the-cdn).

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
- Both answers are UTF-8. A range with `charset=utf-8` wins over the same type with no charset, and a range with another charset does not match. A `charset` with no value counts as no charset.

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
- The server adds the two headers in a header hook, where the response leaves. So a stage before `prerendered` does not see them after its `await next()`. Read them in a header hook.
- In development, the client build has no twins. A request that `prefersMarkdown` accepts gets the framework's answer for the twin's URL, so an edit to the twin's route shows at the next request. If that answer is an error, such as a 404, or is not markdown, the request gets the HTML. A 304 stays a 304. A browser's answer gets no `Vary: Accept` and no `Link`, because the server does not ask the framework for a twin that it does not send.
- In development, React Router gives only the twins in its `prerender` config, as the build does. TanStack Start finds its prerendered pages only during the build, so in development each twin route that answers markdown counts.
- A plugin after `prerendered` does not see a twin, in development or in production, because a twin is a prerendered file. Put an auth check for a twin in `beforeStatic` or in the twin's route.

The default twin is the path with no trailing slash plus `.md`, and `/index.md` for `/`. A request that `rewrite` changes gets no twin. `rewrite` sends that request to another file or to the framework, so it gets the same answer as a browser. For example, when `rewrite` sends `/?q=h100` to the framework, `/?q=h100` gets no twin, and `/gpu/h100` gets `/gpu/h100.md`.

A different mapping goes in `twinOf`. Its path follows the same rules as a request path, and it can give a twin to a request that `rewrite` changes:

```ts
prerendered({
	markdownTwins: { twinOf: ({ path }) => (path === "/" ? "/llms.md" : `${path}.md`) },
});
```

`twinOf` also gets the request's Hono context, the same as `rewrite`. If it gives `undefined`, the request gets no twin, and the answer gets no `Vary: Accept` and no `Link`.

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
const twinOf = ({ path }: { path: string }) => `/markdown${path === "/" ? "/index" : path}.md`;
createServer({ plugins: defaultPlugins({ prerendered: { markdownTwins: { twinOf } } }) });
```

The same route answers the twins in development.

For other negotiation, `rewrite` maps a request path to the file to serve. A request that gets the twin gets the twin's file. When its answer depends on a request header, add a `Vary` for that header in a plugin.

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

A document's headers are not recorded, because the framework sets them for each request (a CSP nonce, the host). Set the headers of a prerendered page with the `headers` option or a plugin. The file also records the hash of each inline script of each HTML file in the client build, so `contentSecurityPolicy()` can give a prerendered page a CSP. See [A CSP for each document](#a-csp-for-each-document). It also holds the build ID (see [Deploys and open tabs](#deploys-and-open-tabs)) and the URL path of Vite's `build.assetsDir`.

## Logs

Pass a sink to use your own format. Attribute names are flat and dotted:

```ts
createServer({
	logger: {
		log: ({ level, message, attributes }) => mySlogger[level](message, attributes),
	},
});
```

The default is `jsonSink()`: one JSON object per line on standard output (stdout). It writes the lines of one event-loop turn in one write, at the end of the turn. Each line still reaches stdout before the process exits, and before the vercel handler returns. `jsonSink()` writes a bigint as a string, such as `"1n"`, and a cycle as `"[Circular]"`. A line whose attributes have no JSON, such as a value whose `toJSON` throws, goes out with `log.error` in place of its attributes, so `jsonSink()` never throws for its attributes. Like `JSON.stringify`, it writes a `Map` or a `Set` as `{}`, so convert it first, such as with `Object.fromEntries(map)`.

In server code, `logger()` gives the logger of the request that runs. Its lines carry the request ID, method, and path as `http.request_id`, `http.method`, and `http.url_details.path`, and these fields win over a field of the same name that you give. Outside a request, such as at module load or in a prerender pass, `logger()` writes to the sink and hooks of the last `createServer` call, else to `jsonSink()`:

```ts
import { logger } from "@ngrok/app-server";

export async function loader() {
	logger().info("loading", { "usr.id": userId });
}
```

An attribute whose value is an `Error` becomes dotted fields under its name: `kind`, `message`, `stack`, each own field other than `kind`, such as `code`, and the `cause` chain as `<name>.cause.*`. An `AggregateError` adds its members as `<name>.errors`. An error with `toJSON` gives its own fields from it. The server's own error lines, such as `unhandled error`, use the same fields:

```ts
logger().error("payment failed", { error });
// {"message":"payment failed","error.kind":"TypeError","error.message":"…","error.stack":"…","error.cause.kind":"Error","error.cause.code":"ECONNRESET",…}
```

On the node host, the server logs one error line for an error that no code catches, such as a rejected promise with no handler: `uncaught exception`, with the fields of the error. `app_server.origin` is `uncaughtException` for a thrown error and `unhandledRejection` for a rejected promise. On Node.js, the line also has the fields of the request that the error came from. The server then drains, and the process exits with code 1. See [Health checks](#health-checks).

The `log` option changes each line of the server and of `logger()` before it goes to the sink. `attributes` gets the attributes after the server flattens each error. `error` gets each error, its attribute name, and its default fields, and gives the fields to write. A field that `error` gives does not replace another attribute of the line, such as `http.method`. `attributes` runs last, so it can change each field:

```ts
createServer({
	log: {
		attributes: ({ attributes }) => ({ ...attributes, "usr.email": undefined }),
		error: ({ prefix, fields }) => ({ ...fields, [`${prefix}.stack`]: undefined }),
	},
});
```

A hook that throws stops neither the line nor the request. The line goes out with `log.error`, which gives the hook and its message, in place of the fields that the hook was to give: each attribute for `attributes`, and the fields of that error for `error`. Why not the fields that the hook got: a hook can redact a value.

`requestContext()` gives the request ID, the logger, the CSP nonce, and the client address of the request that runs. It works with each framework. It gives `undefined` outside a server request:

```ts
import { requestContext } from "@ngrok/app-server";

export async function loader() {
	const requestId = requestContext()?.requestId;
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

`accessLog({ attributes })` adds the app's own attributes to each request line. The callback runs when the line goes out. It gets `{ context, sent }`: the request's context, and what went out as `status`, `headers`, `bytes`, and `aborted`. Read a response header from `sent.headers`, not from `context.res`: `sent.headers` has the headers that went out on each runtime, after the header hooks, and `context.res` can lack them. On Node.js and Vercel, `sent.headers` also has the headers that the listener adds, such as `Content-Length`. `accessLog({ serverTiming: true })` sets `Server-Timing: app;dur=<ms>` on each HTML document: the time until the response headers were ready.

```ts
defaultPlugins({
	requestId: { datadogTraceIds: true },
	accessLog: {
		attributes: ({ context, sent }) => ({
			"usr.id": context.get("userId"),
			"http.response.cache_control": sent.headers.get("Cache-Control"),
		}),
	},
});
```

`userId` stands for a value that a plugin of the app sets with `c.set("userId", …)`. For its type, see the `ContextVariableMap` declaration in [The pipeline](#the-pipeline).

`accessLog()` writes one `request` line for each response, with the level `info`, or `error` for a 5xx. The line has `http.url`, `http.status_code`, `http.useragent`, `http.referer`, `network.client.ip`, `network.bytes_written`, and `duration`. It has `http.route` for a route that the framework matched, and `http.client_aborted` for a client that left before the end of the response.

The server also writes these lines. A line of a request also has `http.request_id`, `http.method`, and `http.url_details.path`. An error goes out as `error.*` fields.

| Message                                        | Level   | Attributes                                          | When                                                                                                                                                               |
| ---------------------------------------------- | ------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `listening`                                    | `info`  | `app_server.urls`                                   | The listeners take connections.                                                                                                                                    |
| `waiting before the drain`                     | `info`  | `app_server.delay_ms`                               | A stop signal came, and `shutdownDelayMs` is more than 0.                                                                                                          |
| `draining`                                     | `info`  | `app_server.deadline_ms`                            | The drain starts.                                                                                                                                                  |
| `the drain deadline passed with open requests` | `warn`  | `app_server.deadline_ms`                            | The drain deadline passed with a request still open. The server closes each open connection. Stop long work on `shutdownSignal()`, or raise `shutdownDeadlineMs`.  |
| `stopped`                                      | `info`  |                                                     | The drain ended.                                                                                                                                                   |
| `plugin shutdown passed the deadline`          | `warn`  | `app_server.deadline_ms`, `app_server.plugins`      | The `onShutdown` hook of each plugin in `app_server.plugins` ran for longer than `shutdownDeadlineMs`. Stop its work on `shutdownSignal()`, or raise the deadline. |
| `plugin shutdown failed`                       | `error` | `error.*`, `app_server.plugin`                      | The `onShutdown` hook of the plugin in `app_server.plugin` threw.                                                                                                  |
| `shutdown failed`                              | `error` | `error.*`                                           | A listener did not stop.                                                                                                                                           |
| `setup failed`                                 | `error` | `error.*`                                           | On a serverless host, the setup threw, such as the `setup` of a plugin. The request fails, and the next request runs the setup again.                              |
| `unhandled error`                              | `error` | `error.*`                                           | A stage, a route, or the framework threw, and the client got a 500. Or a response body failed after its head went out.                                             |
| `access log attributes failed`                 | `error` | `error.*`, and the attributes of the `request` line | The `attributes` callback of `accessLog()` threw. This line goes out in place of the `request` line.                                                               |
| `readiness check failed`                       | `warn`  | `error.*`, when the check threw                     | The `ready` check of `health()` starts to fail, and `/readyz` answers 503.                                                                                         |
| `readiness check passed`                       | `info`  |                                                     | The `ready` check passes again.                                                                                                                                    |
| `client build not found`                       | `warn`  | `app_server.client_directory`                       | At startup, the directory of the client build is not there, so the framework answers each request for a file. Copy the client build to that path.                  |
| `prerendered paths with no file`               | `warn`  | `app_server.missing_paths`                          | At startup, the client build has no file for a prerendered path. The framework answers that path.                                                                  |

## Health checks

`health()` answers `/livez` and `/readyz` with `Cache-Control: no-store`. `/livez` always answers 200. `/readyz` answers 200 until the server gets a stop signal, then 503. `ready` adds an app check, such as a database ping. When the check starts to fail, one warn line goes to the log, and when it passes again, one info line. A stop signal during the check also gives 503. `defaultPlugins()` runs `health()` first, so a probe skips the access log. Its `health` option takes the options of `health()`:

```ts
export default createServer({
	plugins: defaultPlugins({ health: { ready: async () => db.ping() } }),
	shutdownDelayMs: 5_000,
});
```

`livePath` and `readyPath` move the probes. Each must start with `/`, and the two must differ, else startup stops. For a platform with one health URL, set only `readyPath`. `defaultPlugins({ health: false })` turns the probes off, such as for an app with its own `/livez` route.

On Node.js, an HTTP/1.0 request with no `Host` header, such as a probe from HAProxy, gets the host `localhost`, so the probe gets its answer. The same is true for a request with an empty `Host` header. An HTTP/1.1 request with no `Host` header gets a 400 from Node.js itself. Deno answers each of these requests. On Bun, an HTTP/1.0 request with no `Host` and a request with an empty `Host` get a 500, so give the probe a `Host` header.

On a stop signal, a load balancer removes the server some seconds later. Without a delay, the requests that it sends in that time fail. With `shutdownDelayMs`, the server answers 503 on `/readyz` and serves the other requests for that time. Then it drains: it takes no new connection, closes each idle connection, and gives each open request until `shutdownDeadlineMs` to finish. The drain ends when the last response ends. On Node.js, each response that starts in the drain says `Connection: close`, so the client sends no next request on a connection that the drain closes. In Kubernetes, set `terminationGracePeriodSeconds` to more than the delay plus `shutdownDeadlineMs`:

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

A request that is still open at the deadline loses its connection. The server then logs one warn line, `the drain deadline passed with open requests`, with `app_server.deadline_ms`. The access line of a response that the deadline cut has `http.client_aborted: true`, and it comes before the `stopped` line. On Bun, such a response gets no access line. When you see the warn line, raise `shutdownDeadlineMs`, or stop the long responses on `shutdownSignal()`. See [Long-lived responses](#long-lived-responses).

An uncaught error stops the server as a stop signal does: `/readyz` answers 503, the server waits for `shutdownDelayMs`, and then it drains. So one failed request does not cut the other open requests. The process then exits with code 1, and your process manager starts a new one. The server drains for the first uncaught error only: a later one can stop the process at once. An app's own `uncaughtException` listener does not keep the process up. An app's own `unhandledRejection` listener handles a rejected promise, and the server then does not stop.

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

Server code reads the parsed values from `env.values`, such as `env.values.SESSION_KEY`. `env.publicValues` has only the public values.

The values whose names start with `PUBLIC_` go into each HTML document at serve time, prerendered pages included, so one build serves every environment. To use another prefix, set `publicPrefix`, such as `runtimeEnv(schema, { publicPrefix: "VITE_" })`. An empty prefix stops startup, because each value, such as a secret, would then reach the browser. Read the public values in the browser:

```ts
const publicEnv = JSON.parse(document.getElementById("app-server-public-env")?.textContent ?? "{}");
```

When there are public values, the server sends each prerendered page from its file, not from its compressed copy, because the values change the bytes of the page. `streamingCompress()` then compresses the page for each request.

## Long-lived responses

`eventStream()` makes a server-sent event response that sends a heartbeat every 15 s, stops when the client disconnects, and closes at shutdown so the drain does not wait for it. Its options are `signal`, `heartbeatMs` for another heartbeat interval, and `headers` for more response headers:

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

`heartbeatMs` sets the milliseconds between two heartbeats. It must be an integer from 1 to 2,147,483,647, or `eventStream()` throws a `RangeError`.

`send()` does not wait for the client. The events that the client has not read wait in memory, up to 1 mebibyte (MiB). When more than 1 MiB waits:

- The stream stops with an error. On Node.js, the server logs it as an `unhandled error`.
- The server closes the connection. An `EventSource` then connects again and sends the `id` of its last event as `Last-Event-ID`.
- `signal` aborts, with the error as its `reason`.

A producer that sends more than 1 MiB before the client can read it also stops its stream, such as a long replay in one turn of the event loop. Send a long history in another response. On Bun, `Bun.serve` reads the stream ahead of the client and holds the events itself, so the limit does not apply.

For other long work, stop on `shutdownSignal()`.

## Testing

`@ngrok/app-server/testing` runs an app in a test, with no build and no listener.

`createTestServer({ app, files, framework })` starts the app in production mode over a client build of `files`. It records the hashes of the inline scripts of each HTML file, as the build does. `framework` answers each request that no stage answers. The default is a 404. To test data requests, give the run side of an adapter in place of the function: `{ name: "test", fetch, isDataRequest: (path) => path.endsWith(".data") }`. A data request then gets its production headers, such as `Cache-Control: private, no-cache`. Give each test server a new app, because an app runs the `setup` of its plugins one time. `close()` cancels each body that the test did not read, runs each plugin's `onShutdown`, and removes the files.

```ts
import { createTestServer } from "@ngrok/app-server/testing";

const server = await createTestServer({
	app: createServer({ plugins: defaultPlugins({ contentSecurityPolicy: { policy } }) }),
	files: { "providers/index.html": "<!doctype html><script>…</script>" },
	framework: async () => new Response("rendered", { headers: { "Content-Type": "text/html" } }),
});
const response = await server.request("/providers");
response.headers.get("Content-Security-Policy"); // => "script-src 'self' 'sha256-…'"
await server.close();
```

`withRequestContext(values, work)` runs `work` as in a server request, so `requestContext()` and `cspNonce()` give `values`, also in a test environment with a `document`, such as jsdom or happy-dom. Use it to test a render with no mock. With no `logger`, the log lines go nowhere.

```tsx
import { withRequestContext } from "@ngrok/app-server/testing";

const html = await withRequestContext({ cspNonce: "test-nonce" }, () => renderToString(<App />));
```

## Adapters

A framework adapter or a host adapter is two small objects. A third-party adapter uses the same contract.

- `FrameworkBuild` (from `@ngrok/app-server/vite`): the framework's server module, the module of the run side, and how to detect the prerender pass. An optional `runtimeOptions` is the source of an object literal with more options for `runtime`, such as a build constant of the framework. It also takes `contentTypes`, with the same value as on the run side. When one of these types is compressible, the build writes the compressed copies of each file with that type.
- `FrameworkRuntime` (from `@ngrok/app-server`): a `name`, `fetch(request, context)`, plus, when the framework has them, its client build, its prerendered paths, its data requests, and the content types that `mime` lacks. The run-side module exports `runtime(serverModule, { mode })`. To give the access log `http.route`, `fetch` sets `routePattern` on the Hono context to the route pattern that the request matched.
- `HostBuild` (from `@ngrok/app-server/vite`): the module of the run side, and an optional `output` that writes the host's deploy output, such as `.vercel/output`. `output` must be sync, because Vite does not wait for it. It runs one time, after the build and the prerender pass. If `appServer` comes before the framework's plugin, `output` runs after the build and again after the pass, so it must be safe to run two times. `output` gets the paths of the build, the URL path of Vite's `build.assetsDir`, and the logger of the Vite build. The server entry is `app-server.js` in the server build on each host. A host that needs another file writes it in `output`, as `vercel()` does. An optional `copies` gives the encodings of the compressed copies that the host reads for a file of the client build, and the build writes no other copy of that file. With no `copies`, the build writes the gzip and the brotli copy.
- `HostRuntime` (from `@ngrok/app-server`): the client build's files, the default listeners (a serverless host has none), request storage for `requestContext()`, gzip and brotli streams, and a lifecycle for a long-lived process. A host with listeners must give a lifecycle. Without it, a stop signal ends the process with no drain and no `onShutdown`. The run-side module exports `host`. A host that the platform can freeze after a response waits one turn of the event loop after the response closes, so `jsonSink()` writes the lines of the request. The host then waits until `process.stdout.writableLength` is 0, because a full pipe keeps the end of a write in a queue. `files(...).open(path, range)` must honor `range`, because the static stages send those bytes in a 206. An optional `files(...).snapshot()` lists the client build once. The node host makes the list with at most 64 file system calls in flight. For a client build of 10,000 prerendered pages (71,004 files and directories), the list takes about 0.5 s and about 92 MiB of memory at its peak, on an Apple M3 Max. The production server calls it at start, answers each lookup from that list, and keeps each file up to 256 KiB in memory after the first read, up to 32 MiB in all. The `.<file>.gz` and `.<file>.br` copies count in that limit. A client that accepts brotli reads only the `.br` copies, so the copies make the memory that a site needs smaller. If clients read each file in all three forms, a large site can need more than 32 MiB. Then the files that the server reads last stream from disk. Restart the server after you change the client build. A file that you remove while it runs gets a 500, unless it is in memory.
- `ResponseEdge` (from `@ngrok/app-server`): for a listener that writes each response itself. The listener makes one for each request and gives it as the `edge` binding. The server runs the header hooks on a list of the headers and keeps the list in the edge, so it copies no response for them. The listener writes `edge.headersFor(response)` in place of the headers of the response, adds each body byte to `edge.bytes`, gives an error that stops the response to `edge.fail`, and calls `edge.close({ status, aborted, head })` once, with the status and the header list that it sent, and with whether the body stopped before its end. The access log takes its line from that report. Only the first request that gets an edge uses it: a request that the app sends through itself again with `c.env` changes its own response. The node host's listener on Node.js and the vercel handler give one. Without it, as on Bun and Deno, the server makes one new response with the headers after the hooks and a body that counts its bytes.

`createEntry` (from `@ngrok/app-server`) joins the app with the two run sides. The server entry that `appServer` generates calls it, and a build with no Vite plugin can call it too. `serverModule` stands for the framework's server module:

```ts
import { createEntry, createServer } from "@ngrok/app-server";
import { host } from "@ngrok/app-server/node";
import { runtime } from "@ngrok/app-server/react-router";

export const appServer = createEntry({
	app: createServer(),
	host,
	framework: (mode) => runtime(serverModule, { mode }),
});
```

`createEntry` gives an `AppServerEntry`. The CLI calls its `start`. A serverless host calls its `fetch` for each request. A build step can read its `staticPages()`, as `vercel()` does. It gives each prerendered path as a `StaticPage`: the `CdnPage` answer that a CDN can send with no server, or the reason that the server must answer the path. Call `stopPlugins()` when the loop ends.

## Options

`createServer` takes:

- `plugins`: default `defaultPlugins()`.
- `logger`: default `jsonSink()`.
- `log`: hooks that change each log line: `attributes` and `error`. See [Logs](#logs).
- `listeners`: default the host's listeners. A listener decides how connections arrive. On the node host, the default is `[tcp()]` from `@ngrok/app-server/node`. `tcp()` uses `node:http`, `Bun.serve`, or `Deno.serve`. `tcp({ port, host, idleTimeoutMs })` sets the port, the interface, and how long an idle keep-alive connection stays open, in milliseconds. The default `idleTimeoutMs` is `95000`, above the 90 s idle pool of the ngrok edge. Set it above the idle time of your proxy, so the proxy never sends a request on a connection that the server closes. Node.js keeps an idle connection for this time. Bun counts whole seconds, 255 at most, and also closes a response that sends no bytes for this time. Deno has no idle timeout, so the option has no effect there. A value that is not an integer from 0 to 2147482647 stops startup.
- `trustForwardedProto`: read the scheme from `X-Forwarded-Proto`. Set it only behind a proxy that overwrites the header. Default `false`. The server passes it to each listener as `start(fetch, { trustForwardedProto })`, so the node listener on Node.js builds each request with that scheme and copies none. For a listener that ignores it, the server copies each request to change its scheme. For a build with no `server.ts`, set `TRUST_FORWARDED_PROTO=1`. `0`, an empty value, or no value leaves it off. Each other value, such as `true`, stops startup. TanStack Start compares a server function call's `Origin` with the request URL when the browser sends no `Sec-Fetch-Site`, so set this option behind a proxy that ends TLS.
- `trustedProxyHops`: how many proxies in front of the server add to `X-Forwarded-For`, such as `1` behind the ngrok edge. With N, the client address is the Nth address from the right of that header. The access log and `requestContext()?.clientAddress` use it. Default `0`, the address of the socket. Set it only to the number of proxies that you run, else a client can spoof its address. For a build with no `server.ts`, set `TRUSTED_PROXY_HOPS` to that number, such as `TRUSTED_PROXY_HOPS=1`. A value that is not an integer of 0 or more, such as `1e2`, stops startup.
- `shutdownDelayMs`: how long the listeners serve on after a stop signal, before the drain starts. See [Health checks](#health-checks). Default `0`.
- `shutdownDeadlineMs`: how long open requests get to finish after the drain starts. Default `10000`.

## Limits

- The build must serve at `/` (Vite `base`). The Vite plugin fails the build for another base.
- `appServer` does not support React Router `serverBundles`.
- The server build holds one copy of each external package. If the build finds two copies of one external package, such as two versions, the build fails.
- One server process uses one CPU core. To use more cores, run one replica or one container for each core behind the load balancer.
- The package has two host adapters, `node` and `vercel`. Another host, such as Cloudflare Workers, needs its own adapter. See `HostRuntime` and `HostBuild`. A serverless host calls the `fetch` of the build's `appServer` export for each request. The build also exports `hostModule`, the host's run-side module, so a function file can call it through the bundle's copy.
- On Deno, `Deno.serve` logs a notice about its legacy `request.signal` behavior.

## Contributing

Each change meets the six goals of the [north star](./docs/north-star.md): correct, least surprising, fast, delightful, clean, and efficient. [AGENTS.md](./AGENTS.md) is the guide for humans and agents. It lists the goals, the [principles](./docs/principles/README.md) that serve them, and the checks to run before a pull request.
