# @ngrok/app-server

## 0.3.1

### Patch Changes

- [#34](https://github.com/ngrok/app-server/pull/34) [`3221e97`](https://github.com/ngrok/app-server/commit/3221e97a9461ecc4b5b9f82f7f8d7620e3a8be20) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add `cspNonce()` to `@ngrok/app-server/client`. It gives the CSP nonce of the request on the server, and reads it from the document in the browser, so the hydration matches. React Router's `<HydratedRouter>` takes no nonce, so a page with a CSP nonce got a hydration warning in development. Give `cspNonce()` to `<Links>`, `<ScrollRestoration>`, and `<Scripts>` in the root `Layout`:
  
  ```tsx
  const nonce = cspNonce();
  <Links nonce={nonce} />
  <ScrollRestoration nonce={nonce} />
  <Scripts nonce={nonce} />
  ```
  
  In TanStack Start, use `createRouter({ routeTree, ssr: { nonce: cspNonce() } })`.

- [#34](https://github.com/ngrok/app-server/pull/34) [`3221e97`](https://github.com/ngrok/app-server/commit/3221e97a9461ecc4b5b9f82f7f8d7620e3a8be20) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `markdownTwins.twinOf` gets the request's Hono context as its second argument, the same as `rewrite` and `headers`. If `twinOf` gives `undefined`, the request gets no twin, and `rewrite` runs. Use it to keep a request off the prerendered twin, such as a request with a query that the framework renders:
  
  ```ts
  prerendered({
  	markdownTwins: {
  		twinOf: (path, c) =>
  			new URL(c.req.url).search === "" ? `${path === "/" ? "/index" : path}.md` : undefined,
  	},
  });
  ```

## 0.3.0

### Minor Changes

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `bodyLimit({ maxBytes })` plugin and the `bodyLimit` option of `defaultPlugins`. If a request body passes the limit, the client gets a 413. The body still streams to the app, and the plugin does not read it into memory. A `maxBytes` that is not a whole number of 0 or more stops startup. The "Limits" README section says what happens when the app streams the body into its response.
  
  Breaking change: with `defaultPlugins()`, a request body over 10 MiB now gets a 413. Before, the server had no limit. Set `defaultPlugins({ bodyLimit: 50 * 1024 * 1024 })` for a larger limit, or `bodyLimit: false` to keep the old behavior.

- [#22](https://github.com/ngrok/app-server/pull/22) [`0b536a0`](https://github.com/ngrok/app-server/commit/0b536a0e5a066911448f81c8f2d94236c80d17c5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The `appServer` Vite plugin now also writes a brotli copy (`.<file>.br`) next to each gzip copy, when the brotli copy is smaller. `app-server serve` sends the copy that the client's `Accept-Encoding` prefers: brotli, then gzip, then the file. It follows the `q` values, and `q=0` refuses an encoding. In the build of a real docs site, the gzip copies of the 337 scripts are 2.57 megabytes (MB) in all, and the brotli copies are 2.07 MB.
  
  Each encoding of a static file now has its own ETag, such as `W/"5fa9c-19a4e2c8f00-br"`. So a cache that keeps more than one encoding of a file picks the correct one after a 304. A client that holds the ETag of a gzip copy from an earlier version gets one 200 with the new ETag.
  
  `streamingCompress()` now gzips for `Accept-Encoding: *`. It sends the body as it is when `identity` has a higher `q` than gzip.
  
  If you keep the `/assets/*` files of old builds for open tabs, also keep their `.<file>.br` copies.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Answer a `Range` request for a static file. A GET with one `bytes` range gets a 206, and a range past the end of the file gets a 416. Safari now plays a `<video>` from the client build. An HTML file always gets the full page, because `runtimeEnv()` changes its bytes.
  
  Breaking change for a host adapter: `StaticFiles.open` now gets an optional byte range. It must send only the bytes from `range.start` to `range.end`, both inclusive. If an adapter ignores the range, it sends the whole file in a 206, and a keep-alive connection breaks. Before: `open: async (path) => stream(path)`. After: `open: async (path, range) => stream(path, range)`.

- [#18](https://github.com/ngrok/app-server/pull/18) [`a2d8ac2`](https://github.com/ngrok/app-server/commit/a2d8ac24ff1325855944aefb325d8821141e21b0) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `markdownTwins` in development now gives only a twin that the build will prerender, when the framework knows those paths. React Router knows them from its `prerender` config. TanStack Start does not, so each twin route that answers markdown still counts.
  
  Breaking: `SetupInfo.prerenderedPaths` moves into each `mode` member of the union. In development, it is `undefined` when the framework finds the paths only during the build. A plugin that reads it checks `mode` first.

- [#17](https://github.com/ngrok/app-server/pull/17) [`2b0f699`](https://github.com/ngrok/app-server/commit/2b0f699f765ac22d3e0a7853e0fb440e86b063c5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The `appServer` Vite plugin now writes a gzip copy (`.<file>.gz`) next to each text file of 1 kibibyte (KiB) or more in the client build, except HTML. The copy is a dotfile, so it has no URL of its own. `app-server serve` sends the copy to a client that accepts gzip, with its `Content-Length` and `Vary: Accept-Encoding`. The server no longer gzips these files for each request. A script of 19 kilobytes (KB) answers about 70% more gzip requests each second on Node.js, and it sends fewer bytes, because the build uses the highest gzip level.
  
  `appServer()` now gives a list of Vite plugins. An app that puts it in `plugins` needs no change. Code that reads a hook from it, such as `appServer(options).load`, now reads it from the first item: `appServer(options)[0]?.load`.
  
  If you keep the `/assets/*` files of old builds for open tabs, also keep their `.<file>.gz` copies.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `health()` plugin and the `shutdownDelayMs` option of `createServer`. `health()` answers `/livez` with 200. It answers `/readyz` with 200, and with 503 after a stop signal. With `shutdownDelayMs`, the server serves requests for that time after the signal, so the load balancer removes it before the drain. The drain deadline starts after the delay.
  
  `defaultPlugins()` runs `health()` first, so a probe skips the access log. The `health` option takes its options, such as a `ready` check:
  
  ```ts
  defaultPlugins({ health: { ready: async () => db.ping() } });
  ```
  
  Breaking change: with `defaultPlugins()`, the server now answers `/livez` and `/readyz`, and an app route at those paths no longer runs. Remove the app's route, or set `health: false` to keep it.
  
  Before:
  
  ```ts
  const app = createServer({ plugins: defaultPlugins() });
  app.get("/livez", (c) => c.text("ok"));
  ```
  
  After:
  
  ```ts
  const app = createServer({ plugins: defaultPlugins() });
  ```
  
  Or, to keep the app's route:
  
  ```ts
  const app = createServer({ plugins: defaultPlugins({ health: false }) });
  app.get("/livez", (c) => c.text("ok"));
  ```

- [#22](https://github.com/ngrok/app-server/pull/22) [`0b536a0`](https://github.com/ngrok/app-server/commit/0b536a0e5a066911448f81c8f2d94236c80d17c5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The `appServer` Vite plugin now also writes the gzip and brotli copies of each HTML page, and `app-server serve` sends them. The server no longer compresses a prerendered page for each request. On Node.js, a 392 kilobyte (KB) page answers about 21,000 requests each second with `Accept-Encoding: gzip, br`, up from about 2,200.
  
  When `runtimeEnv` has public values, it changes each page. So the server sends those pages from the file, and `streamingCompress()` gzips them for each request, as before.
  
  A `beforeStatic` plugin that changes the bytes of an HTML page must now tell the static stages. Without this, a client that accepts gzip or brotli gets the compressed copy, and the plugin must not change it.
  
  ```ts
  // Before
  middleware: async (c, next) => {
  	await next();
  	c.res = addBanner(c.res);
  },
  
  // After
  middleware: async (c, next) => {
  	c.set("rewritesHtml", true);
  	await next();
  	c.res = addBanner(c.res);
  },
  ```

- [#21](https://github.com/ngrok/app-server/pull/21) [`b59239c`](https://github.com/ngrok/app-server/commit/b59239c578a2ac8841d1f3072aa7690476ce1ece) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `defaultPlugins()` now puts each opt-in plugin in its correct place, so an app does not need to know the order. Use these options:
  
  - `health`: on by default. `false` turns it off.
  - `buildId`: on by default, with the ID of the client build. `false` turns it off.
  - `contentSecurityPolicy`: the options of `contentSecurityPolicy()`.
  - `env`: the plugin from `runtimeEnv(schema)`.
  - `noindex`: `true` turns it on.
  
  These plugins see every response, prerendered pages included. `beforeStatic` stays for the app's own plugins, such as an auth check. They go after the plugins of the options, so they get the CSP nonce, and their responses get the headers of those plugins.
  
  Breaking changes:
  
  - With `defaultPlugins()`, each document and data response now gets `X-Build-Id` and the `build` metric in `Server-Timing`.
  - Two plugins of one named option now stop startup, such as `buildId()` in `beforeStatic` next to the default `buildId`. One would replace the headers of the other, so the value that the app gave would be lost. Move the plugin to its option.
  
  Before:
  
  ```ts
  defaultPlugins({ beforeStatic: [env, buildId({ value: env.values.PUBLIC_APP_VERSION })] });
  ```
  
  After:
  
  ```ts
  defaultPlugins({ env, buildId: { value: env.values.PUBLIC_APP_VERSION } });
  ```
  
  Or remove `buildId` to send the ID of the client build.

- [#13](https://github.com/ngrok/app-server/pull/13) [`1b30ac8`](https://github.com/ngrok/app-server/commit/1b30ac8611fb1aaad9489b9b1ae1c9d2852901e2) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Require Node.js 26. `engines.node` is now `^26.0.0`. Node.js 26 is the active LTS release.
  
  Breaking change: the package no longer supports Node.js 24. Upgrade to Node.js 26 before you upgrade this package.

- [#31](https://github.com/ngrok/app-server/pull/31) [`050dc76`](https://github.com/ngrok/app-server/commit/050dc76ce5b68ab2c5f267472211315cdf40d616) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On Node.js and Vercel, the server writes each response itself, not through the writer of `@hono/node-server`. It runs the header hooks on a list of the headers that it writes, so it copies no response for them. In a one-process A/B on Node.js with `oha` at 64 connections, a small route, a prerendered page, a hashed asset, and a rendered 6 KB page with gzip each answer 13% to 17% more requests each second.
  
  - A body that ends within two reads of the chunks that it has queued goes out with its `Content-Length`, in one socket write with the head. A gzip page whose body has ended goes out in one write too.
  - A streamed page no longer waits for a timer before its shell goes out. This delay hit each streamed page sent without gzip, such as on Vercel.
  - If a step fails before the head goes out, a 500 goes out, and the error gets an `unhandled error` line with the request ID. Such a step is a body that fails or does not match its `Content-Length`, or a header value that Node.js rejects. Before, a body that failed before the head went out as a complete 200 with the bytes read so far.
  - After the head, a body that fails or does not match its `Content-Length` closes the connection, so no client and no cache keeps a cut response as complete. Before, a body longer than its `Content-Length` went out in full.
  - A body chunk that is not a `Uint8Array`, such as a string, gives a 500. The Fetch standard allows bytes only.
  
  Breaking change for a plugin: a header hook of `withHeaderHook` changes the head once, where the response leaves, after the code that each stage runs after `next()`. So code after `await next()` no longer sees the headers that the hooks of later stages set, such as the `Cache-Control` of `privateDocuments()`. Read or change the final headers in a hook:
  
  ```ts
  // Before
  middleware: async (c, next) => {
  	await next();
  	if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  },
  // After
  middleware: async (c, next) =>
  	withHeaderHook(c, next, (headers) => {
  		if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  	}),
  ```
  
  - The hook of an inner stage runs first, so an outer stage has the last word.
  - The static stages and `streamingCompress()` also run the hooks on a view of the headers, to read the `Cache-Control`, and for `streamingCompress()` the `Content-Encoding` and `Content-Range`, that leave. So a hook runs two or three times for a response with gzip or a compressed copy, rendered pages included. Each run must give the same headers, and a hook must do nothing else, such as log, count, or store a value. A `policy` of `contentSecurityPolicy()` and the `paths` of `buildId()` run in a hook too.
  - A hook runs in the request's `requestContext()`. A hook that throws gets the answer of the app's `onError`, as a stage that throws does.
  - On Node.js and Vercel, a wrapper of the app's `fetch` gets the response before the hooks. A header that it sets or deletes goes out, but it does not see the headers that the hooks set.
  - `accessLog({ attributes })` gets what went out as its second argument: the status, the headers after the hooks, the bytes, and whether the body stopped early. Read a response header there, such as `attributes: (c, sent) => ({ cache: sent.headers.get("Cache-Control") })`, not from `c.res`, which can lack the changes of the hooks.
  
  For a listener adapter: a listener that writes each response itself can give each request an `edge` binding, a new `ResponseEdge`. The server keeps the headers after the hooks in the edge, and the access log takes its line from the report of the listener. See the README.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Give each prerendered file a default `Cache-Control`, and add the `cacheControl` option of `prerendered()`. Before, a file with no captured header had none, and each CDN used its own rules.
  
  - An HTML page, a markdown file, and a framework data file, such as a React Router `.data` file, get `public, max-age=0, must-revalidate`.
  - Each other file, such as `robots.txt` or an image, gets `public, max-age=3600, stale-while-revalidate=86400`.
  
  A captured header and the `headers` option win over the default.
  
  Breaking change: a prerendered file with no captured `Cache-Control` now gets a public value. If a prerendered page is behind auth, set `Cache-Control: private` in its auth plugin. To keep the old behavior, set `prerendered({ cacheControl: () => undefined })`.

- [#9](https://github.com/ngrok/app-server/pull/9) [`da0bc54`](https://github.com/ngrok/app-server/commit/da0bc54cbed86fabb8fca948e3104fb507800019) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `trailingSlash({ mode })` plugin and the `trailingSlash` option of `defaultPlugins`. Each page now has one URL. A GET or HEAD for a page URL in the other form gets a 308 to the URL in the site's form. The redirect applies to rendered and prerendered pages, and it keeps the query string and the URL encoding of the path.
  
  - `never` (the default): `/x/` and `/x//` go to `/x`.
  - `always`: `/x` goes to `/x/`. A file in the client build, such as `/LICENSE`, and a path whose last segment has a dot, such as `/llms.txt`, keep their form.
  - `preserve`: no redirect.
  
  Breaking change: with `defaultPlugins()`, a GET or HEAD for `/x/` now gets a 308 to `/x`. Before, it got a 200. Set `trailingSlash: "preserve"` to keep the old behavior.
  
  For TanStack Start, set the same mode in the router, else the redirects loop. `RouterTrailingSlash` from `@ngrok/app-server/tanstack-start` is the router's mode, so `mode satisfies RouterTrailingSlash` fails to type-check when the two modes differ.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `privateDocuments()` plugin as the last stage of `defaultPlugins()`. If a rendered HTML document or a framework data response, such as a React Router `.data` request, has no `Cache-Control`, it gets `private, no-cache`. Then a shared cache never keeps a page or loader data for one user. Prerendered files and `/assets/*` files do not change.
  
  Breaking change: with `defaultPlugins()`, a rendered page with no `Cache-Control` now gets `private, no-cache`. Before, it got none. If a CDN may cache a page, set a value such as `public, max-age=60` in its loader or route headers. A resource route that sends per-user JSON must set its own `Cache-Control`. To remove the plugin, use `defaultPlugins().filter((plugin) => plugin.name !== "private-documents")`.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `securityHeaders()` plugin to `defaultPlugins()`, and add the opt-in `contentSecurityPolicy({ policy })` plugin.
  
  `securityHeaders()` sets these headers on each response, prerendered pages included. If a response already has one of them, it keeps its own value.
  
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Strict-Transport-Security: max-age=31536000`, on an HTTPS request only
  
  Breaking change: with `defaultPlugins()`, each response now gets these headers. Before, it got none. `same-origin` breaks a pop-up that uses `window.opener`, such as some OAuth and payment pop-ups. To change a value, set it in the option. `false` turns one header off, and `securityHeaders: false` turns them all off.
  
  ```ts
  defaultPlugins({
  	securityHeaders: { headers: { "Cross-Origin-Opener-Policy": "same-origin-allow-popups" } },
  });
  ```
  
  `Content-Security-Policy` has no default. To stop other sites from putting a page in a frame, set `frame-ancestors 'none'` in it.
  
  `contentSecurityPolicy({ policy })` sets a `Content-Security-Policy` on each HTML document, prerendered pages included. Turn it on with the `contentSecurityPolicy` option of `defaultPlugins()`. `policy` gets the request's Hono context, so the policy can change by path. It also gets the `script-src` source list that trusts the document's scripts:
  
  - A rendered document gets `'nonce-…' 'strict-dynamic'`, with a new nonce for each request. Read the nonce from `requestContext()?.cspNonce`, from `appServerContext` in React Router, or from `context.appServer` in TanStack Start. Give it to the render.
  - A prerendered document gets `'self'` and the hash of each of its inline scripts. The `appServer` Vite plugin records the hashes of each HTML file in the client build, so an app needs no code to read or hash its pages.
  
  ```ts
  defaultPlugins({
  	contentSecurityPolicy: {
  		policy: (scriptSrc) => `script-src ${scriptSrc}; object-src 'none'; base-uri 'none'`,
  	},
  });
  ```

- [#15](https://github.com/ngrok/app-server/pull/15) [`69e5ec2`](https://github.com/ngrok/app-server/commit/69e5ec2d671ede8109f5a040e95f4469b5d0f6a7) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add `staleBuildReactRouter()` and `staleBuildTanStack()` from the new `@ngrok/app-server/client` entry. After a deploy, they move an open tab to the new build at the next navigation, and the page that the visitor reads never reloads.
  
  - React Router: give `fetch` and `instrumentation` of `staleBuildReactRouter()` to `HydratedRouter`, and export its `middleware` in the root `clientMiddleware`. A navigation to a route with no loader also moves the tab. The document load keeps the URL fragment, and a replace navigation stays a replace.
  - TanStack Start: call `staleBuildTanStack(router)` in `getRouter()`, on the client only. A navigation of a tab that knows of a new build clears the router cache, so the old code never renders the data of a preload.
  - The router tells the module when a navigation starts, after its blockers. A canceled link, `navigate()`, a form, a history step, and `blocker.proceed()` each act as the router acts.
  - If a data request of a navigation gets a response from a new build, the browser loads the target URL as a document. The old code never renders the new data.
  - If the tab already knows of a new build, the next navigation loads its target as a document.
  - A revalidation, a fetcher, an action, the loaders after an action, and a request outside a navigation get their response, and only mark the tab.
  - A build in a response from another origin does not count, also after a redirect.
  - A prefetch, such as a `<Link prefetch="intent">` hover, can show the new build before the click.
  - `onNewBuild(served)` runs once when the tab first sees another build, for the app's RUM tool.
  
  They send no request of their own and add no wait, so a client navigation makes the same requests as before. `defaultPlugins()` runs `buildId()`, so the server needs no code. `buildId()` now also sends the build as `Server-Timing: build;desc="<value>"` on each document and data response, so the client can read the build with no request.
  
  Add the `paths` option of `buildId()`. The responses of those request paths, such as the app's API proxy routes, also carry the build in `Server-Timing`. Each query and mutation through them then tells an open tab about a new deploy, with no extra request. In a TanStack navigation, such a response from a new build loads the page as a document. A response that a cache can use again without the server gets no build. `buildId()` removes the build header and the `build` metric of an upstream API from each response, so the client reads only this app's build.
  
  A header hook can now `delete` a header, with `response.delete(name)`. This adds a member to `ResponseHeaders`, and `buildId()` now removes the `X-Build-Id` header of an upstream API from each response that is not the router's, so this release is a minor.

- [#23](https://github.com/ngrok/app-server/pull/23) [`be87de4`](https://github.com/ngrok/app-server/commit/be87de42d07c02e0fa730d57700b8e2b1037dbd1) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A build with the `appServer` Vite plugin now runs with no install. Copy the build directory alone, and run `node build/server/app-server.js` (`dist/server/app-server.js` for TanStack Start), or the same file with `bun` or `deno run`. The README section "Deploy" has a Dockerfile.
  
  - The plugin bundles each dependency into the server build. For the build, it sets `ssr.noExternal: true`, unless the app sets its own `ssr.noExternal` or sets `ssr.external: true`.
  - Each package in `ssr.external` or in the bundler's `external` option, the whole package of an external subpath, each peer dependency of a package that the app keeps external, the peers of each peer, and each native package stay external. A package is native when a `.node` file is in it, or in a package of its `dependencies` or `optionalDependencies`, such as `oxc-parser`. The build copies each external package, whole, with its installed dependencies, into `node_modules` in the server build. It copies each package in `ssr.external`, also when no code imports it, such as a package that the app reads through `require.resolve`.
  - The build writes a `package.json` with `"type": "module"` into the server build.
  - When a runtime runs `app-server.js` as its main module, the file starts the server, as `app-server serve` does. It sets `NODE_ENV` to `production` when `NODE_ENV` has no value. `app-server serve` works as before.
  - If the build finds two copies of one external package, such as two versions, the build fails.
  
  Breaking change: the server build is larger, and it no longer reads its dependencies from the app's `node_modules`. Run the build on the platform of the server, because the copy holds only the native addon of the build machine. To keep a package out of the bundle, add it to `ssr.external`. Before, a Dockerfile installed `@ngrok/app-server` in the image and ran `node node_modules/@ngrok/app-server/dist/cli.js serve build/server/app-server.js`. After, it copies `build` and runs `node build/server/app-server.js`.

- [#20](https://github.com/ngrok/app-server/pull/20) [`7128871`](https://github.com/ngrok/app-server/commit/7128871ad1d6a221d393b5c90ac25eb9a13849e2) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `appServer()` needs no options. It finds the framework from the React Router or TanStack Start plugin in the Vite config, uses the node host, and uses `server.ts`, else `server.js`, in the Vite root as the app. If the config has neither framework plugin or both, Vite stops with an error that says to pass `framework`. An option that you set replaces its default, so a third-party adapter works as before.
  
  Before:
  
  ```ts
  plugins: [
  	reactRouter(),
  	appServer({ framework: reactRouterAdapter(), host: node(), app: "./server.ts" }),
  ];
  ```
  
  After:
  
  ```ts
  plugins: [reactRouter(), appServer()];
  ```
  
  Breaking change: if the app sets no `app` and has a `server.ts` or `server.js` in the Vite root, the server build now uses that file as the app. Before, the server used the default app. To keep the default app, move or rename the file.

### Patch Changes

- [#31](https://github.com/ngrok/app-server/pull/31) [`050dc76`](https://github.com/ngrok/app-server/commit/050dc76ce5b68ab2c5f267472211315cdf40d616) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The access log costs less on Node.js and Vercel. The listener counts the body bytes as it gives them to the socket, so the access log no longer puts a second stream around each body or copies the response. On Bun and Deno, the server counts the bytes with one stream around the body, as before.
  
  The line changes in these ways:
  
  - The line is for the response that leaves the server, after each stage. A response that an earlier plugin puts in place of the logged one now gets its line, with the status and bytes that the client got. Before, such a response got no line.
  - `http.status_code` is the status that went out, such as the 500 for a response that could not go out.
  - On Node.js and Vercel, `duration` ends when the response closes, after the last bytes go to the socket. For a slow client, it now includes the time to send the body.
  - On Node.js and Vercel, `http.client_aborted` is also set when the client leaves before Node.js sends the last bytes, and when a body fails or ends before its `Content-Length` after the head.
  - A log sink that throws no longer changes the response. Before, such a sink turned a HEAD request into a 500.

- [#16](https://github.com/ngrok/app-server/pull/16) [`e3bbc66`](https://github.com/ngrok/app-server/commit/e3bbc664981c4f0112e63304e3094092264c6a20) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Fix a crash, a file leak, and a build exposure, and make each request cheaper.
  
  - On Node.js 26, a static file response that a later stage dropped unread, such as when a plugin threw after `next()`, crashed the process at garbage collection. The node host now opens a file at the first read, and the gzip stream, the access log, and the `runtimeEnv()` script injection read only when the client reads.
  - A static file response never sends more bytes than its `Content-Length`, even when the file grows after the lookup.
  - `nodeFiles().stat()` throws a file system error that does not mean a missing file, such as `EACCES` or `ELOOP`, so the request gets a logged 500, not a silent miss. `nodeFiles().open()` throws for a file that it cannot read, so the request gets a logged 500, not a 200 whose body fails.
  - `streamingCompress()` sends a body whose `Content-Length` is under 1,024 bytes as it is. Gzip made such a body larger. It adds `Accept-Encoding` to `Vary` once, and only on a type that it can gzip, so an image no longer splits a CDN cache.
  - The static stages hash the `etagPart` values once, not for each static file request.
  - The `appServer` Vite plugin fails the build when the server build is inside the client build. Development does not check, because it serves no build directory. Before, the static stages could serve the server's code, or the whole file system when both builds used one directory.
  - The `appServer` Vite plugin records the captured headers of a prerendered path with a non-ASCII character, such as `/café.json`, under the decoded path that the server looks up.
  - The stale-build client no longer fails a request when `onNewBuild` throws: it reports the error. It reloads a document that the back/forward cache shows again after a move to a new build, and it does nothing on the server.
  - `app-server` accepts `-p` for `--port` and `--help`. A bad argument writes a message and the usage, not a stack trace.

- [#17](https://github.com/ngrok/app-server/pull/17) [`2b0f699`](https://github.com/ngrok/app-server/commit/2b0f699f765ac22d3e0a7853e0fb440e86b063c5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - In production, the server keeps each static file up to 256 kibibytes (KiB) in memory after the first read, up to 32 mebibytes (MiB) in all. A later request or byte range needs no file read. A larger file streams from disk as before. On Node.js, `/robots.txt` answers about 50% more requests each second, and a small hashed asset about 55% more.

- [#21](https://github.com/ngrok/app-server/pull/21) [`b59239c`](https://github.com/ngrok/app-server/commit/b59239c578a2ac8841d1f3072aa7690476ce1ece) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `buildId()` needs no `value` now. After the client build, the `appServer` Vite plugin hashes the name and the content of each file of the client bundle. After the server build, it adds each file that the server build wrote to the client's assets directory, such as the React Router route manifest. It writes the hash as `buildId` in `.app-server.json`. With no `value`, `buildId()` sends that ID.
  
  - The ID changes when the code or the routes that an open tab runs change. A deploy that changes only the server, a `public/` file, or a prerendered page keeps it, so an open tab does not move for nothing.
  - An explicit `value`, such as the image tag, wins. With an unset or empty variable, such as `value: process.env.IMAGE_TAG`, the plugin sends the build's ID.
  - In development, `buildId()` with no `value` sends no build, because Vite's HMR updates an open tab after each edit.
  
  Build the app again, so `.app-server.json` has the build ID.

- [#31](https://github.com/ngrok/app-server/pull/31) [`050dc76`](https://github.com/ngrok/app-server/commit/050dc76ce5b68ab2c5f267472211315cdf40d616) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Each access log line costs a fifth to a third less CPU time, with the same bytes in each line. The access log no longer parses a request URL that has no query, and it copies the line's attributes once, not three times. `jsonSink()` keeps the time string of the current second and millisecond, because `toISOString()` took 0.45 µs to 0.67 µs of each line. On Node.js, a line for a small route takes about 1.1 µs, not 1.6 µs, and a line for a browser page about 1.5 µs, not 2.3 µs. Each request's logger is also about 15% cheaper to make.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `trustedProxyHops` option of `createServer`. Set it to the number of proxies that add to `X-Forwarded-For`, such as `1` behind the ngrok edge. Then the access log and `requestContext()?.clientAddress` give the client's address, not the proxy's. For a build with no `server.ts`, set `TRUSTED_PROXY_HOPS`.

- [#25](https://github.com/ngrok/app-server/pull/25) [`2e49fce`](https://github.com/ngrok/app-server/commit/2e49fcec1c255f69e0b1963b2c86205c0b7fce39) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `app-server start` now sends the `contentSecurityPolicy` for an HTML file in Vite's public directory, such as `public/offline.html`, with the hashes of its inline scripts. Before, the file got no policy in development, so a script that production blocks ran. `devServerStage` takes the new `publicFiles` option for this.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - In development, a response that Vite answers, such as a source module or a `public/` file, now gets the headers of `securityHeaders()`, `noindex()`, and `buildId()`. Before, these responses did not get them, so development and production sent different headers.
  
  Add `withHeaderHook(c, next, hook)`. An app plugin that sets a header uses it to get the same behavior in development. As in production, the hook of an earlier plugin runs last.

- [#31](https://github.com/ngrok/app-server/pull/31) [`050dc76`](https://github.com/ngrok/app-server/commit/050dc76ce5b68ab2c5f267472211315cdf40d616) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - With `trustForwardedProto`, a request on the node host's listener on Node.js no longer gets copied to take its scheme from `X-Forwarded-Proto`, as on Vercel. The listener builds the request with the forwarded scheme. In a one-process A/B on Node.js with `oha` at 64 connections, with `X-Forwarded-Proto: https` on each request as a proxy that ends TLS sends it, routes answer 24% to 39% more requests each second.
  
  For a listener adapter: `Listener.start` takes an optional second argument, `{ trustForwardedProto }`. A listener that builds each request itself can take the scheme from `X-Forwarded-Proto` then. A listener that ignores it, and a caller that gives no second argument, work as before.

- [#24](https://github.com/ngrok/app-server/pull/24) [`a8ae3ea`](https://github.com/ngrok/app-server/commit/a8ae3eab159ede60d9752041230ceac7fc324425) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Fix a 500 with `trustForwardedProto` on the node host. A request with an `X-Forwarded-Proto` that differs from the socket's scheme, such as `https` behind a proxy that ends TLS, now gets the trusted scheme, also with a body. A TRACE request keeps its method.

- [#31](https://github.com/ngrok/app-server/pull/31) [`050dc76`](https://github.com/ngrok/app-server/commit/050dc76ce5b68ab2c5f267472211315cdf40d616) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On Node.js, a gzip response takes one socket write less when its body ends by the time the gzip stream finishes the last chunk: that chunk and the gzip trailer go out as one. In a one-process A/B on Node.js with a stub renderer, a page of 6 KB before gzip that the renderer queues at once answers about 5% more requests each second, and a page that streams its shell first about 3% more. That is about 3 µs less server time for each response, so a page with a slower render gains a smaller share.

- [#31](https://github.com/ngrok/app-server/pull/31) [`050dc76`](https://github.com/ngrok/app-server/commit/050dc76ce5b68ab2c5f267472211315cdf40d616) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On Node.js, a gzip response whose body ends with its first chunk, up to 64 KiB, such as most rendered pages and data responses, uses a zlib stream from a pool. A new zlib stream cost more main-thread time than zlib took to compress a small page. In a one-process A/B with `oha` at 64 connections, a rendered 6 KB page with gzip answers about 16% more requests each second.
  
  The pool keeps up to 16 zlib streams between responses, about 4.3 MiB in all. The gzip bytes of a body depend on that body alone, so a response cannot learn a byte of another response from its own size:
  
  - A stream takes only a body of one chunk, because zlib reads the bytes of an earlier write as history.
  - A stream takes only a body at least as long as each earlier body of that stream. zlib keeps its window after a reset, and it reads the bytes after the end of a body.
  - Each write ends the deflate stream, so the output does not depend on where the output of earlier bodies stopped in the buffer of zlib.

- [#22](https://github.com/ngrok/app-server/pull/22) [`0b536a0`](https://github.com/ngrok/app-server/commit/0b536a0e5a066911448f81c8f2d94236c80d17c5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A static file now keeps its compressed copy back when a `beforeStatic` plugin sets `Cache-Control: no-transform` in its header hook. Before, the static stages read only their own headers, so the client got the copy with `no-transform`. The static stages now run each hook on a copy of the headers first, so a hook can run more than once for one request.

- [#29](https://github.com/ngrok/app-server/pull/29) [`182eca7`](https://github.com/ngrok/app-server/commit/182eca74d000d25b145d9eb7da03518de6cac4cd) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `streamingCompress()` now gzips the chunks that a body has queued together as one chunk, up to 16 kibibytes (KiB). Each gzip flush costs more than its bytes, and React queues many small chunks at once. With gzip, a page that renders on each request now gets about 20% to 30% more requests per second on Node.js, and about 10% to 15% more on Bun and Deno. A chunk that comes later still goes out at once.

- [#31](https://github.com/ngrok/app-server/pull/31) [`050dc76`](https://github.com/ngrok/app-server/commit/050dc76ce5b68ab2c5f267472211315cdf40d616) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Each request passes the plugins with less work. A plugin step no longer wraps each call in one more async function, and a header hook joins one list for each request, not a new copy of the list. In a one-process A/B on Node.js with `oha` at 64 connections, routes answer 2% to 5% more requests each second.

- [#18](https://github.com/ngrok/app-server/pull/18) [`a2d8ac2`](https://github.com/ngrok/app-server/commit/a2d8ac24ff1325855944aefb325d8821141e21b0) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `markdownTwins` changes:
  
  - The HTML answer for a page with a twin now gets `Link: </docs/button.md>; rel="alternate"; type="text/markdown"`, so an agent that does not ask for markdown can find the twin.
  - `markdownTwins` now works in development. A request that prefers markdown gets the framework's answer for the twin's URL, so an edit to the twin's route shows at the next request. If that answer is an error or is not markdown, the request gets the HTML.
  - `prefersMarkdown` returns at once when the `Accept` header does not name markdown. This cuts the time of a browser request for a page with a twin by about 20%.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Send `Cache-Control: no-store` with the 404 for a missing `/assets/*` file, so a CDN does not keep the miss after a deploy. The new "Deploys and open tabs" README section says to keep old assets for 7 days, so an open tab keeps working.

- [#17](https://github.com/ngrok/app-server/pull/17) [`2b0f699`](https://github.com/ngrok/app-server/commit/2b0f699f765ac22d3e0a7853e0fb440e86b063c5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On Node.js, a `fetch()` result in a route is now an `instanceof Response`. The listener no longer replaces the global `Response`, in `serve` and in `start`. This matches Bun and Deno, and small responses are faster. The listener still replaces the global `Request`, so `new Request(c.req.raw)` copies a request.

- [#30](https://github.com/ngrok/app-server/pull/30) [`d93f445`](https://github.com/ngrok/app-server/commit/d93f445489287aad80a10e33b961c844620a88d3) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Each request costs less time on Node.js.
  
  - `jsonSink()` writes the lines of one event-loop turn to stdout in one write, at the end of the turn. Before, each line was its own write. Each line still reaches stdout before the process exits, and before the vercel handler returns. The line format does not change. A `jsonSink(write)` with its own `write` still gets one call for each line.
  - `requestId()` sets its header once for each request. Before, a response from `context.text()` or `context.json()` also got a copy of the header before the route ran. The header, its checks, and the logged ID do not change.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `noindex()` plugin. It sets `X-Robots-Tag: noindex, nofollow` on each response, prerendered pages included, so a search engine does not index a preview deploy. Turn it on with the `noindex` option of `defaultPlugins()`:
  
  ```ts
  defaultPlugins({ noindex: process.env.PREVIEW === "1" });
  ```

- [#17](https://github.com/ngrok/app-server/pull/17) [`2b0f699`](https://github.com/ngrok/app-server/commit/2b0f699f765ac22d3e0a7853e0fb440e86b063c5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The default plugins copy a response at most once to change its headers, not once for each plugin. A small route answers about 10% more requests each second on Node.js. A response object that the app sends again stays unchanged.

- [#25](https://github.com/ngrok/app-server/pull/25) [`2e49fce`](https://github.com/ngrok/app-server/commit/2e49fcec1c255f69e0b1963b2c86205c0b7fce39) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The server build now works with a package that reads a file next to its own module, such as `@vercel/og` with `resvg.wasm`. Such a package stays external, and the build copies it. The build also copies each package that the app's code gives to `require.resolve()` or `import.meta.resolve()` as a string. Before, the app had to add each of these packages to `ssr.external`, else the server failed when it read the file.

- [#25](https://github.com/ngrok/app-server/pull/25) [`2e49fce`](https://github.com/ngrok/app-server/commit/2e49fcec1c255f69e0b1963b2c86205c0b7fce39) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A `RegExp` or a function in the bundler's `external` option now keeps the peers of the packages it matches external. The build tests it on the name of each package in the app's dependencies. Before, the external package and the bundle could each get their own copy of a peer, such as `react`, or the server could not find the peer at run time.

- [#10](https://github.com/ngrok/app-server/pull/10) [`cded0f9`](https://github.com/ngrok/app-server/commit/cded0f9eeff1e66e58d6bdd51c1d458a2e9f5068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add `prefersMarkdown(request)`. It tells if a request asks for markdown before HTML, per acceptmarkdown.com. Only an explicit `text/markdown` range selects markdown, and its `q` must be equal to or more than the `q` of HTML. A wildcard never selects markdown. Use it in a plugin, `entry.server`, or a route, so each place answers one request the same way.
  
  Add the `markdownTwins` option of `prerendered()`. A request that prefers markdown gets the page's prerendered twin, such as `/docs/button.md` for `/docs/button`. Each answer for a page with a twin gets `Vary: Accept`, and a page with no twin gets none. `twinOf` changes the mapping.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `skip` option of `prerendered()`. A path that `skip` matches goes to the app with no file lookup, so the app's auth check runs. A prerendered file answers before the app's routes, so a private page needs `skip` or an auth check in `beforeStatic`. The new "Protect pages" README section shows both.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `redirects(rules)` plugin and the `redirects` option of `defaultPlugins`. Each rule sends a GET or HEAD for an old path to a new URL with a 301 or a 308, and keeps the query string. A rule matches an exact path, `:name` for one segment, and a last `*` for the rest. The first rule that matches wins. The table runs before `trailingSlash` and follows its mode, so an old URL gets one redirect. A rule that is not valid stops startup. The "Redirects" README section has the full rules.

- [#17](https://github.com/ngrok/app-server/pull/17) [`2b0f699`](https://github.com/ngrok/app-server/commit/2b0f699f765ac22d3e0a7853e0fb440e86b063c5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `streamingCompress()` no longer gzips a body from a string under 1 kibibyte (KiB), such as `c.text("ok")`. Such a body has no `Content-Length`, so the plugin gzipped it, and gzip made it larger. A small route answers about 55% more gzip requests each second on Node.js. A streamed page still flushes its first chunk at once.

- [#17](https://github.com/ngrok/app-server/pull/17) [`2b0f699`](https://github.com/ngrok/app-server/commit/2b0f699f765ac22d3e0a7853e0fb440e86b063c5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The node host reads a static file of up to 64 kibibytes (KiB) with one read. A static file that is not in memory, such as `/robots.txt`, answers about 10% more requests each second on Node.js.

- [#17](https://github.com/ngrok/app-server/pull/17) [`2b0f699`](https://github.com/ngrok/app-server/commit/2b0f699f765ac22d3e0a7853e0fb440e86b063c5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - In production, the server lists the client build once at start, and the static stages find each file in that list. A request no longer calls `stat` on the disk, also when no file matches it. A small route answers about 30% more requests each second on Node.js.
  
  The server does not see a file that you add to the client build while it runs. A file that you remove while it runs gets a 500, unless the server keeps it in memory. Restart the server after you change the build. If the walk gets an error that does not mean a missing file, such as `EACCES` or `ELOOP`, the server does not start, and the error names the path. A host adapter can give the same list through the new optional `StaticFiles.snapshot()`.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Log `trace_id` and `span_id` from a valid W3C `traceparent` header on each log line of the request. With `requestId({ datadogTraceIds: true })`, each line also gets `dd.trace_id` and `dd.span_id`, so Datadog connects the line to its trace.
  
  Add `accessLog({ attributes })` to put the app's own attributes on each request line. Add `accessLog({ serverTiming: true })` to set `Server-Timing` on each HTML document.

- [#24](https://github.com/ngrok/app-server/pull/24) [`a8ae3ea`](https://github.com/ngrok/app-server/commit/a8ae3eab159ede60d9752041230ceac7fc324425) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `vercel` host. It runs the pipeline in one Node.js Vercel Function, and Vercel's CDN serves the hashed files.
  
  ```ts
  // vite.config.ts
  import { vercel } from "@ngrok/app-server/vercel/vite";
  
  appServer({ host: vercel() });
  ```
  
  After the build, `vercel()` writes `.vercel/output`. Deploy it with `vercel deploy --prebuilt`.
  
  - The CDN serves the files under `/assets/` with a one-year immutable cache. The `cdnPaths` option adds more prefixes, and `cdnHeaders` adds headers to each CDN file, such as CORS headers.
  - The function answers each other request, prerendered pages included, so each page gets the same headers. It carries the whole server build and the rest of the client build.
  - The request scheme comes from `X-Forwarded-Proto`, and the client address comes from `X-Real-IP`, because Vercel sets both headers.
  - The `regions`, `memory`, and `maxDuration` options set the function's Vercel config.
  
  For a host adapter:
  
  - The `appServer` export of a build has a `fetch(request, bindings)` for a serverless host. It answers one request and does not listen. The first call runs each plugin's `setup`. A failed `setup` logs `setup failed`, and the next call runs each `setup` again.
  - The server entry also exports `hostModule`, the host's run-side module, from the bundle.
  - `HostRuntime.listeners` is optional. `start()` throws when the app and the host have no listener.
  - `HostBuild` has an optional `output` that writes the host's deploy output after the build.

- [#31](https://github.com/ngrok/app-server/pull/31) [`050dc76`](https://github.com/ngrok/app-server/commit/050dc76ce5b68ab2c5f267472211315cdf40d616) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On Vercel, a request no longer gets copied to take its scheme from `X-Forwarded-Proto`. The handler gives `@hono/node-server` the request target with the forwarded scheme, so the request gets its `https:` URL when it is made. Each copy had copied every request header two times. In a one-process A/B of the handler with Vercel's proxy headers and `oha` at 64 connections, routes answer 30% to 41% more requests each second.

## 0.2.0

### Minor Changes

- [#8](https://github.com/ngrok/app-server/pull/8) [`f13c952`](https://github.com/ngrok/app-server/commit/f13c952be7782edd3139862f0892ac8591ca8e17) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The server now works with more than one framework and host. A framework adapter connects the framework. A host adapter decides where the server runs. The package has a React Router adapter, a TanStack Start adapter, and a `node` host adapter. The `node` host runs on Node, Bun, and Deno.
  
  Breaking changes:
  
  - `serverEntry(app)` from `@ngrok/app-server/vite` is now `appServer({ framework, host, app })`. Use `reactRouterAdapter()` from `@ngrok/app-server/react-router/vite` and `node()` from `@ngrok/app-server/node/vite`.
  - The Vite plugin adds `server/app-server.js` to the server build and does not change the framework's entry. `app-server serve` with no path runs `build/server/app-server.js`, then `dist/server/app-server.js`, then `build/server/index.js`.
  - The plugin writes `.app-server.json` in place of `.headers.json`. Build the app again.
  - `tcp` and `TcpOptions` move to `@ngrok/app-server/node`. With no `listeners`, `createServer` uses the host's listeners.
  - `createEntry` takes a `host`, and `framework` returns a `FrameworkRuntime`. `FrameworkAdapter` is now `FrameworkRuntime`.
  - `createAdapter` and `appServerEntry` from `@ngrok/app-server/react-router` are now `runtime(build, { mode })`.
  - `SetupInfo` has `files` in place of `clientDirectory`, and `devServer` in place of `viteMiddleware`.
  - The entry protocol is now 2. Install the same version of the package that the build uses.
  - The package supports ES modules only. The Vite plugin fails the build when the server build is not an ES module, such as React Router's `serverModuleFormat: "cjs"`.
  
  New features:
  
  - `@ngrok/app-server/tanstack-start` and `@ngrok/app-server/tanstack-start/vite` serve a TanStack Start app, with prerendered pages, server functions, and streamed pages. `app-server start` runs it with HMR.
  - `requestContext()` gives the request ID and logger of the request that runs, with each framework.
  - The Vite plugin fails the build when the Vite `base` is not `/`.

### Patch Changes

- [#5](https://github.com/ngrok/app-server/pull/5) [`3aec041`](https://github.com/ngrok/app-server/commit/3aec04179bb304755a2164bfe88e243038635191) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `app-server start` and `app-server serve` exit when their shutdown is done. Before, a timer that the app left kept the stopped process alive. The render abort timer in React Router's `entry.server` held it for 6 s after each Ctrl+C or deploy.
  
  On Bun, `app-server serve` now stops at the drain deadline when a response body stays open. Before, the shutdown never finished.

- [#6](https://github.com/ngrok/app-server/pull/6) [`ca66ccd`](https://github.com/ngrok/app-server/commit/ca66ccd294c480bf8ff87d7935ecf861eab1a112) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `ListenerBindings.remoteAddress` now accepts `undefined`, so a listener can pass the address that its runtime reports as is.
  
  When the `start` of a listener throws before it returns a promise, `listen()` now stops the listeners that started before it. Before, those listeners kept running.

## 0.1.1

### Patch Changes

- [#3](https://github.com/ngrok/app-server/pull/3) [`2c71a17`](https://github.com/ngrok/app-server/commit/2c71a1703e58864ce19488ae2a3e4b7575612394) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `app-server start` tries the next port when its port is in use. Set Vite's `server.strictPort` to stop on a port in use. `app-server serve` does not change: a port in use stops startup.

- [#3](https://github.com/ngrok/app-server/pull/3) [`2c71a17`](https://github.com/ngrok/app-server/commit/2c71a1703e58864ce19488ae2a3e4b7575612394) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add `--port` to `app-server start` and `app-server serve`. The flag wins over `PORT`.

- [#3](https://github.com/ngrok/app-server/pull/3) [`2c71a17`](https://github.com/ngrok/app-server/commit/2c71a1703e58864ce19488ae2a3e4b7575612394) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Rename the CLI commands. `app-server dev` is now `app-server start`. `app-server start` is now `app-server serve`. Update the scripts in `package.json`:
  
  ```json
  {
  	"scripts": {
  		"start": "app-server start",
  		"serve": "app-server serve"
  	}
  }
  ```

## 0.1.0

### Minor Changes

- [#1](https://github.com/ngrok/app-server/pull/1) [`ec8ad43`](https://github.com/ngrok/app-server/commit/ec8ad434b70e457cb7af834bf0a3b13f5bfe5069) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add `@ngrok/app-server`, a composable Hono app server for React Router that replaces `@react-router/serve`. It runs the same request pipeline in development and production, on Node, Bun, and Deno.
  
  - Serves each prerendered page at its own URL with a 200. `@react-router/serve` answers the same URL with a 301 to a trailing slash.
  - Replays the headers of each prerendered resource route and `.data` file (`Content-Type`, `Cache-Control`, CORS). The `serverEntry` Vite plugin records them during the prerender pass into `build/client/.headers.json`.
  - Gzips text responses and flushes after each chunk, so a streamed page shell or a server-sent event reaches the client at once.
  - Writes one JSON access line per request, static files included, with Datadog standard attribute names and redacted query values. Pass your own log sink to use your own format.
  - Gives each request an `X-Request-Id`, and passes the ID and a request logger to loaders through `appServerContext`.
  - Validates the environment at startup with `runtimeEnv(schema)`, and writes the `PUBLIC_*` values into each HTML document at serve time. A plugin's `etagPart` goes into each static ETag, so a 304 never keeps an old value.
  - Drains open requests at shutdown, with a deadline, and closes event streams from `eventStream()` so the drain does not wait for them. The keep-alive timeout is 95 s, above the ngrok edge's idle pool.
  - Every feature is a plugin that an app can drop, replace, or reorder, and the app can add plain Hono routes. `prerendered({ rewrite })` lets an app negotiate content, such as a markdown twin of a page.
  - The build exports `appServer`, and the CLI calls it, so one copy of the package runs the server.
  
  Run it with `app-server dev` and `app-server start`. The README has the setup.
