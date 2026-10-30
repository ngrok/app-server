# @ngrok/app-server

## 0.3.0

### Minor Changes

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `bodyLimit({ maxBytes })` plugin and the `bodyLimit` option of `defaultPlugins`. If a request body passes the limit, the client gets a 413. The body still streams to the app, and the plugin does not read it into memory. A `maxBytes` that is not a whole number of 0 or more stops startup. The "Limits" README section says what happens when the app streams the body into its response.
  
  Breaking change: with `defaultPlugins()`, a request body over 10 MiB now gets a 413. Before, the server had no limit. Set `defaultPlugins({ bodyLimit: 50 * 1024 * 1024 })` for a larger limit, or `bodyLimit: false` to keep the old behavior.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Answer a `Range` request for a static file. A GET with one `bytes` range gets a 206, and a range past the end of the file gets a 416. Safari now plays a `<video>` from the client build. An HTML file always gets the full page, because `runtimeEnv()` changes its bytes.
  
  Breaking change for a host adapter: `StaticFiles.open` now gets an optional byte range. It must send only the bytes from `range.start` to `range.end`, both inclusive. If an adapter ignores the range, it sends the whole file in a 206, and a keep-alive connection breaks. Before: `open: async (path) => stream(path)`. After: `open: async (path, range) => stream(path, range)`.

- [#13](https://github.com/ngrok/app-server/pull/13) [`1b30ac8`](https://github.com/ngrok/app-server/commit/1b30ac8611fb1aaad9489b9b1ae1c9d2852901e2) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Require Node.js 26. `engines.node` is now `^26.0.0`. Node.js 26 is the active LTS release.
  
  Breaking change: the package no longer supports Node.js 24. Upgrade to Node.js 26 before you upgrade this package.

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

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `securityHeaders()` plugin to `defaultPlugins()`, and add the opt-in `cspNonce({ policy })` plugin.
  
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
  
  `cspNonce({ policy })` sets a `Content-Security-Policy` with a new nonce on each HTML document. Read the nonce from `requestContext()?.cspNonce`, from `appServerContext` in React Router, or from `context.appServer` in TanStack Start. Give it to the render.

### Patch Changes

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `trustedProxyHops` option of `createServer`. Set it to the number of proxies that add to `X-Forwarded-For`, such as `1` behind the ngrok edge. Then the access log and `requestContext()?.clientAddress` give the client's address, not the proxy's. For a build with no `server.ts`, set `TRUSTED_PROXY_HOPS`.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - In development, a response that Vite answers, such as a source module or a `public/` file, now gets the headers of `securityHeaders()`, `noindex()`, and `buildId()`. Before, these responses did not get them, so development and production sent different headers.
  
  Add `withHeaderHook(c, next, hook)`. An app plugin that sets a header uses it to get the same behavior in development. As in production, the hook of an earlier plugin runs last.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `health()` plugin and the `shutdownDelayMs` option of `createServer`. `health()` answers `/livez` with 200. It answers `/readyz` with 200, and with 503 after a stop signal. With `shutdownDelayMs`, the server serves requests for that time after the signal, so the load balancer removes it before the drain. The drain deadline starts after the delay. `health()` is not in `defaultPlugins()`, so put it first: `[health(), ...defaultPlugins()]`.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Send `Cache-Control: no-store` with the 404 for a missing `/assets/*` file, so a CDN does not keep the miss after a deploy. The new "Deploys and open tabs" README section says to keep old assets for 7 days, so an open tab keeps working.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `noindex()` plugin. It sets `X-Robots-Tag: noindex, nofollow` on each response, so a search engine does not index a preview deploy. For a preview deploy, put it in `beforeStatic`.

- [#10](https://github.com/ngrok/app-server/pull/10) [`cded0f9`](https://github.com/ngrok/app-server/commit/cded0f9eeff1e66e58d6bdd51c1d458a2e9f5068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add `prefersMarkdown(request)`. It tells if a request asks for markdown before HTML, per acceptmarkdown.com. Only an explicit `text/markdown` range selects markdown, and its `q` must be equal to or more than the `q` of HTML. A wildcard never selects markdown. Use it in a plugin, `entry.server`, or a route, so each place answers one request the same way.
  
  Add the `markdownTwins` option of `prerendered()`. A request that prefers markdown gets the page's prerendered twin, such as `/docs/button.md` for `/docs/button`. Each answer for a page with a twin gets `Vary: Accept`, and a page with no twin gets none. `twinOf` changes the mapping.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `skip` option of `prerendered()`. A path that `skip` matches goes to the app with no file lookup, so the app's auth check runs. A prerendered file answers before the app's routes, so a private page needs `skip` or an auth check in `beforeStatic`. The new "Protect pages" README section shows both.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add the `redirects(rules)` plugin and the `redirects` option of `defaultPlugins`. Each rule sends a GET or HEAD for an old path to a new URL with a 301 or a 308, and keeps the query string. A rule matches an exact path, `:name` for one segment, and a last `*` for the rest. The first rule that matches wins. The table runs before `trailingSlash` and follows its mode, so an old URL gets one redirect. A rule that is not valid stops startup. The "Redirects" README section has the full rules.

- [#14](https://github.com/ngrok/app-server/pull/14) [`6f60119`](https://github.com/ngrok/app-server/commit/6f601194e39a6f6ae9e94c1edf54f935c6e6b8dc) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Log `trace_id` and `span_id` from a valid W3C `traceparent` header on each log line of the request. With `requestId({ datadogTraceIds: true })`, each line also gets `dd.trace_id` and `dd.span_id`, so Datadog connects the line to its trace.
  
  Add `accessLog({ attributes })` to put the app's own attributes on each request line. Add `accessLog({ serverTiming: true })` to set `Server-Timing` on each HTML document.

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
