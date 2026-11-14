# @ngrok/app-server

## 0.5.0

### Minor Changes

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Breaking changes to the build side of the package: the `/vite` and `/react-router` entries, and the adapter contracts `FrameworkBuild` and `HostBuild`. An app that uses `appServer()`, `node()`, `vercel()`, `reactRouterAdapter()`, and `tanstackStartAdapter()` as the README shows needs no change for them. One change reaches the environment of a deploy: see the first item.
  
  **A bad `TRUST_FORWARDED_PROTO` or `TRUSTED_PROXY_HOPS` now stops startup.** For a build with no `server.ts`, these variables set `trustForwardedProto` and `trustedProxyHops`. Before, `TRUST_FORWARDED_PROTO=true` left the option off with no error and no log line. Behind a proxy that ends TLS, the server then sent no `Strict-Transport-Security` header and gave the app an `http:` request URL. `TRUSTED_PROXY_HOPS=1e2` counted as 100 proxies, and `TRUSTED_PROXY_HOPS=abc` failed with a message about `trustedProxyHops` and `NaN`.
  
  - `TRUST_FORWARDED_PROTO` takes `1` or `0`.
  - `TRUSTED_PROXY_HOPS` takes an integer of 0 or more.
  - For each of them, no value and an empty value keep the default.
  - Each other value stops startup with a message that names the variable, the value, and the fix. This includes a value with a space or a carriage return, such as `" 1"`, which `TRUSTED_PROXY_HOPS` took before. The message shows the value as JSON, so a hidden character shows as `"1\r"`.
  
  ```sh
  # Before: the server starts, and does not trust X-Forwarded-Proto.
  # After: the server stops with this message.
  # TRUST_FORWARDED_PROTO must be "1" or "0", not "true". Set TRUST_FORWARDED_PROTO=1 to trust X-Forwarded-Proto, or remove the variable.
  TRUST_FORWARDED_PROTO=true app-server serve
  
  # The fix: the server starts, and trusts X-Forwarded-Proto.
  TRUST_FORWARDED_PROTO=1 app-server serve
  ```
  
  Check the environment of each deploy of a build with no `server.ts` before you upgrade. This also applies to the vercel host: a bad value there fails the `cdnPages` step of the build, or each request to the function. In `app-server start`, the first request shows the message.
  
  **Four exports that only the package used are gone.**
  
  - `SERVER_ENTRY_ID` and `serverEntrySource` from `@ngrok/app-server/vite` have no replacement. The entry now exports only `appServer` and its types.
  - `isServerBuild` from `@ngrok/app-server/react-router`: call `runtime()`, which throws for a module that is not a React Router server build.
  - The type `AppServerContext` from `@ngrok/app-server/react-router`: use `RequestContext` from `@ngrok/app-server`, which is the same type.
  
  ```ts
  // Before
  import type { AppServerContext } from "@ngrok/app-server/react-router";
  
  // After
  import type { RequestContext } from "@ngrok/app-server";
  ```
  
  `app-server serve` with a module that is not a server build still stops at startup. Its message is now `The server module is not a React Router server build.`
  
  **`FrameworkBuild` and `HostBuild` have no `name`.** No log and no error read it. Delete `name` from the object of a custom adapter. TypeScript reports each one in a typed object literal.
  
  **`HostBuild` has no `entryFileName`.** The server entry is `app-server.js` in the server build on each host, which is where `app-server serve` looks for it. `node()` and `vercel()` gave that name already. A custom host that gave another name now gets `app-server.js`, also in plain JavaScript, where no type error shows it. Such a host must read `entryFile` in its `output`, or write its own file there, as `vercel()` writes `vercel-function.js`.
  
  A custom host before and after these two changes:
  
  ```ts
  // Before
  appServer({ host: { name: "edge", runtimeModule: "edge-host", entryFileName: "app-server.js" } });
  
  // After
  appServer({ host: { runtimeModule: "edge-host" } });
  ```
  
  **`FrameworkBuild` has no `validate`.** The `appServer` plugin now checks Vite's `base` itself, for each framework adapter. Before, each adapter of the package made the check, so a custom adapter with no `validate` built with a `base` other than `/`, and the server then served at `/` only. Such a build now fails with `@ngrok/app-server serves a build at "/" only`. The plugin no longer calls `validate`, also in plain JavaScript, where no type error shows it. To check the Vite config, add a Vite plugin with a `configResolved` hook.
  
  ```ts
  // Before
  appServer({ framework: { ...adapter, validate: (config) => check(config) } });
  
  // After
  plugins: [{ name: "my-check", configResolved: (config) => check(config) }, appServer({ framework: adapter })];
  ```

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Breaking changes to the install and to the contracts of a plugin, a host adapter, and a listener. The first change is for each app. The others are for an app with a plugin that logs in `setup`, a host or a listener of its own, or an import of a removed export.
  
  **`hono` is a peer dependency (`^4.13.16`), not a dependency.** The app and the package now share one copy of Hono, and the server runs on the app's version. Before, the package had its own copy at one pinned version (4.13.14 in 0.4.1), and an app with another version got a second copy. TypeScript then refused a middleware of the app's copy, such as `cors()` from `hono/cors`, as the `middleware` of a plugin, and it refused `app.route("/api", new Hono())`.
  
  The install line of the README stays `pnpm add -E @ngrok/app-server hono`. The app must have `hono` 4.13.16 or later:
  
  ```sh
  # An app with no `hono` of its own, or with `hono` below 4.13.16
  pnpm add -E hono
  ```
  
  pnpm, npm, and Bun install a peer that the app does not have. Yarn does not, and pnpm with `auto-install-peers=false` does not.
  
  We measured an empty app with the install line of the README, when the latest Hono was 4.13.18 and the package pinned 4.13.16. The app had 2 versions of Hono and 3 type errors before, and it has 1 version and 0 errors now. The server build of a React Router app whose `server.ts` imports `cors()` held two copies of Hono before, and it holds one now: the JavaScript in `build/server` goes from 1,821,793 to 1,761,656 bytes.
  
  **`info.logger` in the `setup` of a plugin is a logger with one method for each level**, as `logger()` and `c.get("logger")` are. Before, it was the sink. TypeScript reports each call. In JavaScript, the old call throws when it runs.
  
  ```ts
  // Before
  info.logger.log({ level: "warn", message: "cache is cold", attributes: { "cache.entries": 0 } });
  // After
  info.logger.warn("cache is cold", { "cache.entries": 0 });
  ```
  
  **`HostRuntime` and `Listener` have no `name`.** No log and no error read it. Delete `name` from a host or a listener of your own. TypeScript reports each one.
  
  ```ts
  // Before
  const listener: Listener = { name: "unix", start };
  // After
  const listener: Listener = { start };
  ```
  
  **`HostRuntime.listeners` is a list, not a function**, as the `listeners` option of `createServer` is. TypeScript reports the old form. In JavaScript, a host that still gives a function fails at start with `This app server has no listener`. The docs of `HostRuntime.lifecycle` now say that a host with `listeners` must give a lifecycle, else a stop signal ends the process with no drain.
  
  ```ts
  // Before
  export const host: HostRuntime = { files, listeners: () => [tcp()], lifecycle };
  // After
  export const host: HostRuntime = { files, listeners: [tcp()], lifecycle };
  ```
  
  **`@ngrok/app-server` no longer exports `PUBLIC_ENV_SCRIPT_ID`, `RunningServer`, and `FrameworkRuntimeFactory`.** No public function used the two types. Browser code could not import the constant, because the import pulled the server into the client bundle.
  
  - For `PUBLIC_ENV_SCRIPT_ID`, write the ID: `document.getElementById("app-server-public-env")`.
  - For `FrameworkRuntimeFactory`, declare the function: `runtime(serverModule: unknown, options: { mode: Mode }): FrameworkRuntime`. Add the fields of your `runtimeOptions` to `options`.
  - `RunningServer` has no replacement.
  
  **`@ngrok/app-server/node` no longer exports `devServerStage`, `DevServerStageOptions`, and `NodeMiddleware`.** Only `app-server start` used them, and they have no replacement. A server build on the node host holds the code of each export of this module, so it loses the dev server stage and the script hash code. A build on the vercel host does not change.
  
  - Without them, the module in a server build is about 9 kB smaller before minification, and about 3 kB smaller with gzip.
  - The module no longer loads `node:http` and `node:crypto` at import. On Bun 1.3.14, the import of the module takes about 8.4 ms, not 12.7 ms. On Deno 2.9.8, it takes about 14.6 ms, not 18.7 ms.
  - On Node.js, the time to `listening` does not change, because the listener of `tcp()` loads `node:http` when it starts.
  
  We measured a Vite SSR bundle of `import * as hostModule from "@ngrok/app-server/node"` with `ssr.noExternal`, as the generated server entry imports it. For the time, a new process imported the bundle. Each time is the median of 40 interleaved runs after 5 warm-up rounds, on an Apple M3 Max.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The options of the plugins get one name for each job, and a bad value or a bad plugin list now stops startup. Each breaking change has a before and an after.
  
  Breaking change: the option that names the build header is now `headerName` in `buildId()`, `staleBuildReactRouter()`, and `staleBuildTanStack()`, as in `requestId()`. Before, it was `header`. JavaScript ignores the old name with no error, and the server then sends `X-Build-Id` again.
  
  ```ts
  // Before
  defaultPlugins({ buildId: { header: "X-App-Build" } });
  staleBuildReactRouter({ header: "X-App-Build" });
  staleBuildTanStack(router, { header: "X-App-Build" });
  
  // After
  defaultPlugins({ buildId: { headerName: "X-App-Build" } });
  staleBuildReactRouter({ headerName: "X-App-Build" });
  staleBuildTanStack(router, { headerName: "X-App-Build" });
  ```
  
  Breaking change, for a listener that writes each response itself: `ResponseEdge.close` now takes one object, so the call says what each value is. Before, it took three positional values. JavaScript gives no error for the old call: the access log line then has no status.
  
  ```ts
  // Before
  edge.close(status, aborted, head);
  
  // After
  edge.close({ status, aborted, head });
  ```
  
  The object costs about 60 bytes of heap for each response on Node.js and Vercel, and no time that the benchmark shows. Measured on Node.js 26.13 on an Apple M3 Max, with the built `ResponseEdge` of one build and only the `close` line changed: one edge for one response (`new`, `claim`, `useHeaders`, `onSent`, `close`) takes 36.2 ns before and 35.5 ns after, and 956 bytes of heap before against 1,015 bytes after. Each number is the median of 5 runs in turn, and each run is the median of 9 rounds of 3,000,000 edges. Three sets of runs gave a cost from 56 to 64 bytes. For scale, one `/ping` request through `defaultPlugins()` allocates about 38,700 bytes.
  
  Breaking change: `health()` now stops startup for a `livePath` or a `readyPath` that does not start with `/` or that has `?` or `#`, and for one path for both probes. Before, such a path never answered, because a request path starts with `/` and has no query and no fragment. One path for both probes always answered 200, so `ready` never ran, and the path did not answer 503 at shutdown. The check also finds one option that has the default of the other, such as `readyPath: "/livez"`. For a platform with one health URL, set only `readyPath`.
  
  ```ts
  // Before
  defaultPlugins({ health: { livePath: "/healthz", readyPath: "/healthz", ready } });
  
  // After
  defaultPlugins({ health: { readyPath: "/healthz", ready } });
  ```
  
  The error names the option, the value, and the fix:
  
  ```
  health needs a livePath and a readyPath that differ. Both are "/healthz", so the readiness check would never run. For one health URL, set only readyPath.
  ```
  
  Breaking change: a header name or a header value in an option that no header can hold now stops startup. Before, the server started, and each response that got the header was a 500, while `/livez` and `/readyz` answered 200. The log line did not name the option. The checks cover `headerName` of `requestId()` and `buildId()`, `value` of `buildId()`, `unlessHeader` of `noindex()`, and each value of `securityHeaders({ headers })`. A value can hold a tab and each character from U+0020 to U+00FF except U+007F, so a value such as `café` still works.
  
  ```ts
  // Before: the server started, and each page answered 500.
  defaultPlugins({ buildId: { value: "v42\n" } });
  defaultPlugins({ securityHeaders: { headers: { "Content-Security-Policy": "frame-ancestors ‘none’" } } });
  
  // After: remove the line break, and use the ASCII quote.
  defaultPlugins({ buildId: { value: "v42" } });
  defaultPlugins({ securityHeaders: { headers: { "Content-Security-Policy": "frame-ancestors 'none'" } } });
  ```
  
  An empty `unlessHeader` also stops startup now. Before, `noindex({ unlessHeader: "" })` started and set no `X-Robots-Tag` on any response, so a search engine could index a preview deploy. Give the header a name, or use `noindex: true`.
  
  ```ts
  // Before
  defaultPlugins({ noindex: { unlessHeader: process.env.EDGE_HEADER ?? "" } });
  
  // After
  defaultPlugins({ noindex: process.env.EDGE_HEADER ? { unlessHeader: process.env.EDGE_HEADER } : true });
  ```
  
  The error names the option, the value, and the fix:
  
  ```
  The value of buildId must be a value that a header can hold, not "v42\n". Remove each control character, such as a line break, and each character above U+00FF.
  ```
  
  Breaking change: a second plugin of the options `requestId`, `accessLog`, `securityHeaders`, `bodyLimit`, `trailingSlash`, or `prerendered` of `defaultPlugins()` now stops startup, as a second `health`, `noindex`, `buildId`, `contentSecurityPolicy`, or `env` plugin already did. Before, the server started, and the two copies did not act as one. For example, a second `bodyLimit()` with a higher limit changed nothing, a second `trailingSlash()` in another mode sent each page into a redirect loop, and a second `accessLog()` wrote two lines for each request. A second `redirects()` still starts, because a second table is valid. Use the option:
  
  ```ts
  // Before
  createServer({ plugins: [...defaultPlugins(), bodyLimit({ maxBytes: 52_428_800 })] });
  
  // After
  createServer({ plugins: defaultPlugins({ bodyLimit: 52_428_800 }) });
  ```
  
  Two lists that worked before now also stop startup. A second `bodyLimit()` with a lower limit: set the `bodyLimit` option to the lower limit. A second `prerendered()` for the paths that the first one skips: use one `prerendered`, whose `skip`, `rewrite`, `headers`, and `cacheControl` decide by path. To put your own copy of a plugin at another place, turn the option off with `false`, or filter the default out of the list:
  
  ```ts
  createServer({
  	plugins: [...defaultPlugins().filter((plugin) => plugin.name !== "access-log"), accessLog()],
  });
  ```
  
  Breaking change: a plugin of the options `securityHeaders`, `noindex`, `buildId`, `contentSecurityPolicy`, or `env` that comes after `prerendered()` in the plugin list now stops startup. Before, the server started, and each prerendered page went out with no CSP, no `X-Robots-Tag`, no build ID, or no public `runtimeEnv` values, while each rendered page had them. Development serves no prerendered page, so only production showed the failure. The check does not read the build, so such a list also stops startup for an app with no prerendered page. Use the option, or put the plugin before `prerendered()`, such as in `beforeStatic`:
  
  ```ts
  // Before
  createServer({ plugins: [...defaultPlugins(), contentSecurityPolicy({ policy }), noindex(), env] });
  
  // After
  createServer({
  	plugins: defaultPlugins({ contentSecurityPolicy: { policy }, noindex: true, env }),
  });
  ```
  
  The error names the plugin, the option, and the other way out:
  
  ```
  The noindex plugin comes after prerendered(), so the prerendered pages do not get it. Set the "noindex" option of defaultPlugins(), or put the plugin before prerendered().
  ```
  
  Breaking change: when `prerendered({ cacheControl })` gives `undefined` for a file, the file now gets the default `Cache-Control`. Before, it got none, so a function that set a value for some files took the default off each other file, and each CDN then used its own rules for them. The example of the option did that:
  
  ```ts
  prerendered({
  	cacheControl: (file) => (file.startsWith("/images/") ? "public, max-age=86400" : undefined),
  });
  // Before: `/about`, `/about.data`, and `/llms.txt` had no `Cache-Control`.
  // After: `/about` and `/about.data` have `public, max-age=0, must-revalidate`, and `/llms.txt` has
  // `public, max-age=3600, stale-while-revalidate=86400`.
  ```
  
  `cacheControl: () => undefined` no longer removes the header. To send no `Cache-Control`, delete it in a header hook of a plugin before the static stages. A prerendered file behind an auth check still needs `Cache-Control: private` from the auth plugin.
  
  ```ts
  // Before
  defaultPlugins({ prerendered: { cacheControl: () => undefined } });
  
  // After
  const noCacheControl: Plugin = {
  	name: "no-cache-control",
  	middleware: async (c, next) =>
  		withHeaderHook({
  			context: c,
  			next,
  			hook: (response) => {
  				if (isClientBuildFile(c.req.path)) {
  					response.delete("Cache-Control");
  				}
  			},
  		}),
  };
  defaultPlugins({ beforeStatic: [noCacheControl] });
  ```
  
  `isClientBuildFile` stands for the app's own test of the path. Without it, the hook also removes the header of each rendered page.
  
  Breaking change: `redirects` now stops startup for a `from` that no request path can equal: one with a query, a fragment, a dot segment, or a character that is not percent-encoded, such as a space or `é`. It also stops startup for a segment of `from` that starts with `:` or has `*` and is not `:name` or `*`, such as `:id?`, `:slug*`, `(.*)`, and `*.html`. Before, each of these rules started, and its old URL got the framework's 404. A rule matches the path only, so a rule cannot select one query.
  
  ```ts
  // Before: each rule started and never matched.
  redirects([
  	{ from: "/café", to: "/cafe" },
  	{ from: "/old?page=1", to: "/new" },
  	{ from: "/blog/:slug*", to: "/articles/:slug" },
  ]);
  
  // After
  redirects([
  	{ from: "/caf%C3%A9", to: "/cafe" },
  	{ from: "/old", to: "/new" },
  	{ from: "/blog/*", to: "/articles/*" },
  ]);
  ```
  
  A literal segment that starts with `:` or has `*`, such as `/files/:1` or `/a*b`, did redirect before. It also stops startup now, and it has no form in a rule. Answer such a path with a route of the app.
  
  The error names the rule and the fix:
  
  ```
  The redirect from /café can never match. A rule matches the path only. Write it percent-encoded, with no query and no fragment: /caf%C3%A9.
  ```
  
  Breaking change: `runtimeEnv(schema, { publicPrefix: "" })` now throws. Before, an empty prefix made each value public, so the server wrote each value, secrets included, into each HTML document. Set a prefix of one character or more, and give each public value a name with that prefix.
  
  ```ts
  // Before: `SESSION_KEY` went into each HTML document.
  runtimeEnv(z.object({ API_URL: z.url(), SESSION_KEY: z.string() }), { publicPrefix: "" });
  
  // After
  runtimeEnv(z.object({ PUBLIC_API_URL: z.url(), SESSION_KEY: z.string() }));
  ```

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Breaking change: `appServer({ app })` with a path to no module now stops `app-server start` when it starts, with an error that names the path and the Vite root:
  
  ```
  @ngrok/app-server found no module at /app/srever.ts for the `app` option. Give a path from the Vite root, /app.
  ```
  
  Before, `start` printed its URLs, and then each request got a 500 with `Failed to load url … in virtual:@ngrok/app-server/entry`. A build already failed for such a path, and it now fails with the same error. A path with no extension, such as `app: "server"`, still works.
  
  ```ts
  // Before: `start` printed its URLs, and each request got a 500.
  // After: `start` stops with the error.
  appServer({ app: "./srever.ts" });
  
  // The fix: give the path of the module.
  appServer({ app: "./server.ts" });
  ```
  
  If you start `app-server start` before the app module exists, start it again after you make the file.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - In `app-server start`, an app with no `logger` option now writes its log lines, such as `request` and `unhandled error`, in the text format of Go's `log/slog`, as the other lines of `start` do. Before, those lines were JSON between the text lines of Vite and of `start`.
  
  ```
  time=2026-11-13T23:03:26.685Z level=INFO msg=request http.request_id=c6cb08cb-7c9b-42ee-970d-cd6a70d3f562 http.method=GET http.url_details.path=/ http.url=/ http.status_code=200 http.useragent=curl/8.7.1 network.client.ip=::1 network.bytes_written=8 duration=4926083
  ```
  
  Breaking change: a tool that reads the lines of `app-server start` as JSON no longer gets JSON from an app with no `logger` option. For JSON in development too, give `logger: jsonSink()`.
  
  ```ts
  // Before: JSON lines in development and in production.
  createServer({ plugins: defaultPlugins() });
  
  // After: for JSON lines in development too.
  createServer({ plugins: defaultPlugins(), logger: jsonSink() });
  ```
  
  An app that gives `logger` does not change, and production still writes JSON. A line that module code writes with `logger()` before the first request is still JSON. As in JSON, a line has no field for an attribute that is `undefined`.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - In `app-server start`, a plugin list with no `assets()` now fails each request with this error:
  
  ```
  No plugin runs the dev server, so Vite serves no source module, HMR client, or CSS. Add assets() to the plugin list.
  ```
  
  Before, the page rendered, but each request for a Vite module, the HMR client, or a CSS file got the 404 of the framework, with no log line that said why. `assets()` is the plugin that runs Vite in development.
  
  This is a breaking change for an app that gives its own plugin list with no `assets()`, such as `defaultPlugins().filter((plugin) => plugin.name !== "assets")`. Add `assets()` to the list:
  
  ```ts
  // Before
  createServer({ plugins: [requestId(), accessLog(), prerendered()] });
  
  // After
  createServer({ plugins: [requestId(), accessLog(), assets(), prerendered()] });
  ```
  
  A plugin of your own that reads `info.devServer` in its `setup` and runs it also passes. `defaultPlugins()` has `assets()`, and production does not change. A test that calls `fetchDev` of a server entry needs the same change.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The node host now drains after an uncaught error, then exits with code 1. An uncaught error is an error that no code catches, such as a rejected promise with no handler in a route. Before, the runtime stopped the process at once: each open request lost its connection, and the log had no line for the error, only the runtime's text on standard error (stderr).
  
  - The server logs one error line, `uncaught exception`, with the fields of the error. `app_server.origin` is `uncaughtException` or `unhandledRejection`. On Node.js, the line also has the fields of the request that the error came from, such as `http.request_id`.
  - The server then stops as it does on `SIGTERM`: `/readyz` answers 503, the server waits for `shutdownDelayMs`, and it drains until `shutdownDeadlineMs`. So the exit comes later than before, by up to the sum of the two times.
  - The exit code is still 1. The server drains for the first uncaught error only: a later one can stop the process at once, as before.
  - An app's own `unhandledRejection` listener still handles a rejected promise on each runtime. The server then logs no line and does not stop.
  
  This applies to `app-server serve` and `node build/server/app-server.js` on Node.js, Bun, and Deno. `app-server start` and the vercel host do not change.
  
  Breaking change: an app's own `uncaughtException` listener no longer keeps the process up. Before, a process with such a listener stayed up after an uncaught error. Now the listener still runs, and then the server drains and the process exits with code 1. On Deno, the same is true for a web `error` listener that calls `preventDefault()`. No option keeps the process up, so run the server under a process manager that starts a new process, such as Kubernetes or systemd.
  
  Measured on Node.js 26.13, Bun 1.3.14, and Deno 2.9.8, with two runs for each runtime before and after: a 400 ms request was open when a route left a rejected promise with no handler. Before, the open request failed on each runtime, and the process exited 8 to 9 ms after the error, with 13 to 18 lines on stderr. Now the open request completes on each runtime, and the process exits with code 1 after 357 to 360 ms, with one JSON error line and no line on stderr.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - **Breaking:** `eventStream()` takes `produce` first and its options last, and `send()` returns a promise that an app can await.
  
  - `send()` resolves when the client has read the earlier events down to 64 KiB of unread bytes, or when the stream ends. It never rejects. A producer that awaits it slows down for a slow client, so the server keeps little in memory. Before, the events that a client did not read stayed in memory with no limit.
  - A stream with more than 1 MiB of unread bytes stops: the response fails, and the producer's `signal` aborts with an error that says `Await send()`. Only a producer that does not await `send()` gets there.
  - The heartbeat skips a ping while the client has unread events.
  
  Before:
  
  ```ts
  return eventStream({ signal: request.signal }, async ({ send, signal }) => {
  	for await (const update of watch({ signal })) {
  		send({ data: JSON.stringify(update) });
  	}
  });
  ```
  
  After:
  
  ```ts
  return eventStream(
  	async ({ send, signal }) => {
  		for await (const update of watch({ signal })) {
  			await send({ data: JSON.stringify(update) });
  		}
  	},
  	{ signal: request.signal },
  );
  ```
  
  With no options, `eventStream({}, produce)` is now `eventStream(produce)`.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `eventStream()` now throws a `RangeError` for a `heartbeatMs` that a timer cannot hold: `NaN`, a value under 1, or a value over 2,147,483,647. The message names the value. Before, the timer turned such a value into 1 ms with no error. Each open stream then sent a `: ping` comment each millisecond: about 90 comments in 100 ms, in a test on Node.js 26.13.
  
  Breaking change: a route that passes such a value now throws on each request. Before, it sent its stream. `0` and `Infinity` are such values, and they never turned the heartbeat off. Pass a value from 1 to 2,147,483,647. No value turns the heartbeat off, and the largest value is about 24.8 days.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `tcp({ idleTimeoutMs })` now takes a value above 299 s on Node.js, such as `620_000` behind a load balancer that keeps idle connections for 600 s. Before, such a value stopped startup with an error about `headersTimeout`. For such a value, the server also raises the request timeout of Node.js from 300 s to the idle timeout plus 1 s.
  
  `tcp()` now checks `idleTimeoutMs` when the app calls it. A value that is not an integer from 0 to 2147482647 throws an error that names the option and the value, on Node.js, Bun, and Deno.
  
  Breaking change: on Bun and Deno, a value that is not an integer from 0 to 2147482647 now stops startup. Before, Bun started with a value such as `Infinity`, `1.5`, or the string `"95000"`: it rounded the value up to whole seconds and used 255 s at most. Deno started with each value, because it does not use the option. Pass an integer from 0 to 2147482647. For example, change `idleTimeoutMs: Infinity` to `idleTimeoutMs: 255_000` on Bun, and change a string from the environment to a number. On Node.js, such a value already stopped startup.
  
  The README and the JSDoc now say what each runtime does with the option: Node.js keeps an idle connection for this time. Bun counts whole seconds, 255 at most, and also closes a response that sends no bytes for this time. Deno has no idle timeout, so the option has no effect there.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - **Breaking:** the access line attribute `http.client_aborted` is now `http.aborted`. Why: the attribute is also `true` when the server stops the body, such as a body that fails after its first chunk, or a response that the drain deadline cuts. An operator who dropped these lines as client noise also dropped the responses that the server broke. A 5xx whose client left before the app answered logs as `499`, so that line still tells a client abort from a server fault.
  
  Before:
  
  ```txt
  @http.client_aborted:true
  ```
  
  After:
  
  ```txt
  @http.aborted:true
  ```
  
  Change each Datadog query, monitor, and dashboard that uses `@http.client_aborted`. A query on the old name finds nothing, with no error.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - **Breaking:** four public functions take named arguments: one object, or a subject and then one options object.
  
  - `withHeaderHook({ context, next, hook })` takes one object. The new type `HeaderHookOptions` names it.
  - A host adapter's `files(...).open(path, { range })` takes `range` in an options object.
  - `ResponseEdge.useHeaders({ base, headers })` takes one object.
  - `AppServerEntry.fetchDev(request, { bindings, devServer })` takes an options object, and `bindings` is optional. The entry protocol is now 3, so the CLI refuses a build from an earlier version. Install the same version of `@ngrok/app-server` that the build uses.
  
  Before:
  
  ```ts
  const frameOptions: Plugin = {
  	name: "frame-options",
  	middleware: async (c, next) =>
  		withHeaderHook(c, next, (headers) => {
  			headers.set("X-Frame-Options", "DENY");
  		}),
  };
  
  const files: StaticFiles = {
  	stat,
  	open: async (path, range) => read(path, range),
  };
  ```
  
  After:
  
  ```ts
  const frameOptions: Plugin = {
  	name: "frame-options",
  	middleware: async (c, next) =>
  		withHeaderHook({
  			context: c,
  			next,
  			hook: (headers) => {
  				headers.set("X-Frame-Options", "DENY");
  			},
  		}),
  };
  
  const files: StaticFiles = {
  	stat,
  	open: async (path, options) => read(path, options?.range),
  };
  ```

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Breaking change: `@ngrok/app-server/node` no longer exports `nodeFiles` and `parsePort`. Only the package used them, and the server entry of each node-host build held their code.
  
  - For `nodeFiles(clientDirectory)`, use `host.files(clientDirectory)` from the same entry.
  - `parsePort` has no replacement. `tcp()` reads and checks `PORT`.
  
  ```ts
  // Before
  import { nodeFiles } from "@ngrok/app-server/node";
  const files = nodeFiles(clientDirectory);
  
  // After
  import { host } from "@ngrok/app-server/node";
  const files = host.files(clientDirectory);
  ```

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `createServer` now stops startup for an entry of the plugin list that is not a plugin: a function, a list, a promise, or a value that is not an object. The `Plugin` type now rejects a function. Before, the compiler took a Hono middleware, or a plugin factory that the app did not call, as a plugin, and the server started and never ran it. For example, `defaultPlugins({ beforeStatic: [basicAuth({ username, password })] })` sent each page with no auth check.
  
  The error names the entry and the fix:
  
  ```
  plugins[7] is the function basicAuth, not a plugin. Call a plugin factory, such as requestId(). Put a Hono middleware in a plugin, such as { name: "auth", middleware: basicAuth() }.
  ```
  
  Breaking change: a Hono middleware in the plugin list now stops startup. Before, the server started and never ran the middleware. Put the middleware in a plugin.
  
  ```ts
  // Before
  defaultPlugins({ beforeStatic: [basicAuth({ username, password })] });
  
  // After
  defaultPlugins({
  	beforeStatic: [{ name: "auth", middleware: basicAuth({ username, password }) }],
  });
  ```
  
  Breaking change: a plugin factory that the app does not call now stops startup. Before, the server started without the plugin. Call the factory.
  
  ```ts
  // Before
  createServer({ plugins: [requestId, accessLog] });
  
  // After
  createServer({ plugins: [requestId(), accessLog()] });
  ```
  
  Breaking change: an entry that is not an object, such as `false` from `condition && plugin`, now stops startup. Before, the server skipped `false`, a string, or a number. To add a plugin on a condition, spread a list.
  
  ```ts
  // Before
  createServer({ plugins: [...defaultPlugins(), isDebug && debugHeaders] });
  
  // After
  createServer({ plugins: [...defaultPlugins(), ...(isDebug ? [debugHeaders] : [])] });
  ```
  
  Breaking change: a list of plugins as one entry, such as `defaultPlugins()` with no spread, now stops startup. Before, the server started and ran no plugin of that list. Spread the list.
  
  ```ts
  // Before
  createServer({ plugins: [defaultPlugins(), auth] });
  
  // After
  createServer({ plugins: [...defaultPlugins(), auth] });
  ```
  
  Breaking change: a promise of a plugin, such as the result of an `async` plugin factory with no `await`, now stops startup. Before, the server started without the plugin. Wait for the plugin.
  
  ```ts
  // Before
  defaultPlugins({ beforeStatic: [loadAuth()] });
  
  // After
  defaultPlugins({ beforeStatic: [await loadAuth()] });
  ```
  
  Breaking change: a function with a `middleware` field of its own now stops startup, as each function does. So does a plugin object that has a `then` function, because the server takes it as a promise. Before, the server ran the `middleware` of both. Give the plugin as an object with no `then` field.
  
  ```ts
  // Before
  const auth = Object.assign(() => {}, { middleware: basicAuth({ username, password }) });
  
  // After
  const auth = { name: "auth", middleware: basicAuth({ username, password }) };
  ```
  
  Breaking change for TypeScript: the `Plugin` type has a new `call?: never` field, which a function cannot meet. So the compiler also rejects a plugin object that has a `call` field. Give that field another name.
  
  A `plugins` option that is not a list, such as `defaultPlugins` with no call, stopped startup before too. Its error now names the fix.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A request no longer stays in memory for the life of a timer that it leaves, and the lists of a request that the server owns leave the public types. Both changes break a type. The first is for a host adapter of your own, and the second is for a plugin that read or set one of three context keys. An app on the node host or the vercel host that uses neither changes nothing.
  
  **A `RequestStore` holds a `RequestScope`, not the Hono context.** `RequestScope` is a new type export. A host passes it through and reads no field of it. TypeScript reports the old type. In JavaScript, a host needs no change.
  
  ```ts
  // Before
  import type { Context } from "hono";
  import type { AppServerEnv } from "@ngrok/app-server";
  const storage = new AsyncLocalStorage<Context<AppServerEnv>>();
  // After
  import type { RequestScope } from "@ngrok/app-server";
  const storage = new AsyncLocalStorage<RequestScope>();
  ```
  
  Why: Node.js keeps the stored value of the code that makes a timer until the timer fires. So a timer that a loader or an `entry.server` left, such as a render abort timer that the entry does not clear, kept the Hono context of its request, and with it Node's request and response, the `Response`, and each header hook. When the response is sent, the server now puts the request's values in the scope and lets go of the context.
  
  - `requestContext()` and `logger()` give the same values in work that the request started, also after the response is sent. The lines of that logger then carry the request fields (`http.request_id`, `http.method`, `http.url_details.path`, and the trace IDs) that the request had when the response ended. A logger that the app set with `c.set("logger", …)` stays.
  - On Bun and Deno, a request of a plugin list with no `accessLog()` keeps its context as before. Why: their listeners do not tell the server when a response ends, and the server puts a stream around the body to see that end only for the access log.
  
  We measured a React Router page of the test fixture on the node host with the default plugins, on Node.js 26.13 and an Apple M3 Max, with the build before the change and the build after it in turn, 3 times each.
  
  - Each request that left a 60 s timer kept 10,107 bytes of heap before and keeps 529 bytes now. With no request storage, the timer alone keeps 149 bytes. We sent 20,000 requests with `oha -c 16` and read `heapUsed` after two garbage collections.
  - With a 6 s timer for each request and 60,000 requests at about 5,200 requests each second, the peak `heapUsed` goes from 636 to 803 MB down to 152 to 182 MB, and the peak resident set size (RSS) from 975 to 1,132 MB down to 412 to 445 MB. The time in minor garbage collections goes from 562 to 615 ms down to 299 to 308 ms, and the CPU time of the server for each request from 292 to 309 microseconds down to 269 to 278.
  - With no timer, the same load shows no change in 2 rounds: 265 to 268 microseconds of CPU time for each request before, and 266 to 268 now.
  - A request with a stub framework, which takes 3 to 12 microseconds, is at most 4% slower, and this benchmark cannot tell that from its noise. We sent requests in one process through the built pipeline, the two builds in turn, 41 rounds of 30,000 requests, 3 times. The median ratio of the time after to the time before was 1.00 with no plugin, 1.02 to 1.04 with the default plugins, and 1.00 to 1.03 with a response edge, as the node listener gives it. Two copies of the build before gave 0.99 to 1.02 and 0.94 to 1.00 for the last two cases.
  
  The wrapper that runs each request in the request storage also makes one promise less for each request. In a micro benchmark of the wrapper alone, a call takes 307 ns, not 327 ns (15 interleaved rounds of 300,000 calls, 3 repeats). The time of a full request does not show it.
  
  **`AppServerEnv["Variables"]` no longer has `etagParts`, `headerHooks`, and `sentReports`.** The server owns these lists. A plugin that set one of them replaced the list that the server reads: after `c.set("headerHooks", [])`, a rendered page lost `Cache-Control: private, no-cache`, and after `c.set("sentReports", [])`, the request got no access log line. TypeScript now reports a `c.get` or a `c.set` of the three keys. The server runs the same code as before, so a JavaScript plugin can still set them, and must not.
  
  ```ts
  // Before
  const frameOptions: Plugin = {
  	name: "frame-options",
  	middleware: async (c, next) => {
  		c.get("headerHooks")?.push((headers) => {
  			headers.set("X-Frame-Options", "DENY");
  		});
  		await next();
  	},
  };
  // After
  import { withHeaderHook } from "@ngrok/app-server";
  
  const frameOptions: Plugin = {
  	name: "frame-options",
  	middleware: async (c, next) =>
  		withHeaderHook({
  			context: c,
  			next,
  			hook: (headers) => {
  				headers.set("X-Frame-Options", "DENY");
  			},
  		}),
  };
  ```
  
  For a value in the ETag of each static file, give the plugin an `etagPart`, not a write to `etagParts`. `sentReports` has no replacement: the package exports no function that reports the end of a response.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `app-server start` now reports a port in use as `vite dev` does: in Vite's words, through Vite's logger. So Vite's `logLevel` and `customLogger` apply to the line, as they do to the URL lines.
  
  Breaking change: the two log lines of `start` for a port in use are gone, with their `server.port` and `server.address` attributes. A tool that reads them must read Vite's lines.
  
  - When `start` moves to the next port, it prints `Port 3000 is in use, trying another one...`. Before, it printed `time=… level=INFO msg="port in use, trying the next port" server.port=3000`, also with `logLevel: "silent"`.
  - With `server.strictPort`, `start` stops with the error `Port 3000 is already in use`. Before, the error was `listen EADDRINUSE: address already in use …`. That error is now the `cause`.
  - With `server.strictPort`, when another server holds the port on a wildcard address, `start` prints Vite's warning for that case. Before, it printed a line with the message `port in use on a wildcard address`.
  - When no port from 3000 to 65535 is open, `start` stops with the error `No available ports found between 3000 and 65535`. Before, the error was `No open port from 3000 to 65535.`.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `app-server start` now does three more things as `vite dev` does:
  
  - **`server.resolvedUrls`:** a Vite plugin now reads the URLs of the server from `server.resolvedUrls`, from the `listening` event of `server.httpServer` on, and after a Vite restart. Before, the value was `null`.
  - **`server.open`:** `start` now opens the browser when Vite's `server.open` is `true` or a path. `BROWSER` and `BROWSER_ARGS` apply, and `BROWSER=none` opens nothing. On Deno, give `--allow-run`. As in `vite dev`, Vite also sends one request for that URL at startup, also with `BROWSER=none`, so the app renders the page one time. Vite's `server.preTransformRequests: false` turns that request off. Before, `start` ignored the option.
  - **`server.https`:** `start` serves HTTP only. It now writes a warning when `server.https` has a value that turns HTTPS on in `vite dev`, also when a plugin such as `@vitejs/plugin-basic-ssl` sets it. The warning comes again after each Vite restart. `server.https: false` gets no warning. Before, `start` served HTTP with no message.
  
  With `server.https` set, Vite also turned off its check of the `Host` header. A plain HTTP server needs that check against a DNS rebinding attack, so `start` now keeps it on. This is a breaking change for an app that sets `server.https` and opens `start` through a tunnel or a proxy with another host name: Vite now answers 403 for that host. Add the host to `server.allowedHosts`, as an app with no `server.https` does.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - With `markdownTwins`, `prerendered()` now adds `Vary: Accept` and the `Link` to the twin in a header hook. Before, it copied each response for a path with a twin to set the two headers. The client gets the same headers.
  
  Breaking change for a plugin: a stage before `prerendered()` no longer sees the two headers on `c.res` after its `await next()`, as with each header that a hook sets. Read them in a header hook.
  
  ```ts
  // Before
  middleware: async (c, next) => {
  	await next();
  	const link = c.res.headers.get("Link");
  },
  
  // After
  middleware: async (c, next) =>
  	withHeaderHook({
  		context: c,
  		next,
  		hook: (headers) => {
  			const link = headers.get("Link");
  		},
  	}),
  ```
  
  The hook also adds the two headers to a response that an earlier stage puts in place of the answer after its `next()`, such as a 401 for a path with a twin. Before, that response had neither.
  
  In process, with the default plugins and `markdownTwins: true`, and a `ResponseEdge` as the node listener calls the server (5 processes, each with 9 rounds of 3,000 requests, the build before and this change in turn; Node.js 26.13, Apple M3 Max, with other load on the machine): a prerendered page with a twin takes 0.90 of its time before (19.0 µs to 17.2 µs), the twin for an agent 0.92, and a rendered page with a twin 0.94. Each ratio is the middle of 3 runs. A path with no twin takes the same time (0.987 and 1.008 in 9 processes).

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - One breaking change to the contract of a host adapter. An app with no host adapter of its own needs no change.
  
  **`FileInfo` is a union on `kind`, and a directory has no `size` and no `mtimeMs`.** No code reads a size or a time of a directory, and the node host made up `size: 0` to fit the type. A `stat` of a host adapter of your own now gives only `{ kind: "directory" }` for a directory. Code that reads `size` or `mtimeMs` must check `kind === "file"` first. TypeScript reports each place.
  
  ```ts
  // Before
  const files: StaticFiles = {
  	stat: async (path) =>
  		isDirectory(path)
  			? { kind: "directory", size: 0, mtimeMs: 0 }
  			: { kind: "file", size: sizeOf(path), mtimeMs: timeOf(path) },
  	open,
  };
  const info = await files.stat("/docs");
  const size = info?.size;
  
  // After
  const files: StaticFiles = {
  	stat: async (path) =>
  		isDirectory(path)
  			? { kind: "directory" }
  			: { kind: "file", size: sizeOf(path), mtimeMs: timeOf(path) },
  	open,
  };
  const info = await files.stat("/docs");
  const size = info?.kind === "file" ? info.size : undefined;
  ```
  
  `nodeFiles(...).stat(path)` and the `stat` of its snapshot give `{ kind: "directory" }` for a directory, with no `size: 0` and no `mtimeMs`. No response changes. In JavaScript, a host that still gives the two fields for a directory works as before.

### Patch Changes

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `accessLog()` redacts the query of a request URL with no URL parse, when each part of the query is `key=value` and each key has only letters, digits, and the characters `-_.!~*'()`. Most queries have this form, such as the `?_routes=…` of a React Router data request. Each other query gets the parse, as before. On Node.js and Bun, the line of a URL that parses is the same.
  
  One line is new. A request whose URL does not parse, as with a `Host: 1.2.3.4.5` header, got no line when its URL had a query. When the query has this form, the line now goes out, as it does for such a URL with no query. With a query of another form, the request still gets no line.
  
  On Node.js v26.13, a request with such a query costs about 1 µs less CPU time. A React Router data request through the default plugins with no compression costs about 6% less in the pipeline. The numbers come from requests in one process with no socket: the median of 21 rounds that take turns between the build before and this one, in 3 runs.
  
  Deno gives each request URL as the client sent it. So on Deno, the line for a URL with such a query now shows the path as the client sent it, as the line for a URL with no query does.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On Node.js, two requests now run the pipeline, with the host `localhost` in the URL: an HTTP/1.0 request with no `Host` header, and a request with an empty `Host` header. Before, each got a 400 with no log line, before the first stage. So an HTTP/1.0 health probe of `/livez`, which HAProxy sends by default, failed with no sign on the server, and the load balancer marked each replica as down.
  
  An HTTP/1.1 request with no `Host` header still gets a 400 from Node.js itself, before the pipeline. On Node.js, a request with a `Host` that is not valid also still gets a 400. Deno already answers a request with no `Host`. On Bun, an HTTP/1.0 request with no `Host` and a request with an empty `Host` still get a 500, so give the probe a `Host` header there.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The static stages and `streamingCompress()` now run the header hooks on a view only when the request has a hook that a built-in plugin did not add. Before, they ran each hook on a view for each file with a compressed copy and for each response that `streamingCompress()` compresses, to find a `no-transform`, a `Content-Encoding`, or a `Content-Range` from a hook. No hook of a built-in plugin sets these. So with only built-in plugins, each hook now runs one time, where the response leaves. No response changes.
  
  An app hook keeps its contract. When a request has a hook from `withHeaderHook`, or a hook that a stage adds to `headerHooks` itself, each hook of the request still runs on the view. So the app hook can read a header that a built-in hook sets. The `paths` of `buildId()` and the `policy` of `contentSecurityPolicy()` run in a built-in hook. With no app hook, they now run one time for these responses.
  
  In process, with the default plugins and a `ResponseEdge` as the node listener calls the server (3 processes for each kind of request, each with 60 pairs of 500 requests after a warm-up, the build before and this change in turn; Node.js 26.13, Apple M3 Max, with other load on the machine). Each time and each heap size is the median of the differences of the pairs in a process:
  
  - A prerendered page with a brotli copy takes 0.23 µs to 0.55 µs less of 15.4 µs.
  - A hashed asset with a copy takes 0.37 µs to 0.48 µs less of 14.9 µs.
  - A 304 for the page takes 0.54 µs to 0.61 µs less of 13.0 µs.
  - Each of the three allocates 1.2 KB to 1.5 KB less on the heap, which is about 3%, in 57 to 60 of the 60 pairs.
  - A rendered page that `streamingCompress()` compresses allocates 2.7 KB to 3.0 KB less of 60.8 KB, in each pair (3 processes, each with 40 pairs of 300 requests). The change in its time is inside the noise of brotli.
  - With one app hook before the default plugins, the page and the asset stay the same: in 6 processes, the mean difference is inside 0.25 µs and 0.12 KB, in both directions.

- [#74](https://github.com/ngrok/app-server/pull/74) [`f481611`](https://github.com/ngrok/app-server/commit/f4816111d0a1bb9322c8e007cde40b50c90bc310) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The package now needs `hono` 4.13.16 or later, and it pins `@hono/node-server` 2.1.6, to get their security fixes:
  
  - An `ECONNRESET` during a WebSocket upgrade no longer stops the Node process.
  - A backslash in the request path is no longer a path separator, so a path rule at a reverse proxy applies.
  - `hono` fixes `csrf()`, `validator('form')`, `mount()`, wildcard middleware in `RegExpRouter`, and HTML escapes in the `css` helper.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - With `requestId({ headerName })`, `vercel({ cdnPages })` now gives the CDN each prerendered page that qualifies. Before, a request ID header with another name kept each page in the function, with the reason `the x-correlation-id header changes with the request` in the build log, because the build's check knew only `X-Request-Id`. The check now gets the name from the `requestId()` plugin of the app. A page that the CDN serves has no request ID header, as before.
  
  The check does not know `X-Request-Id` by its name now. If your own plugin sets `X-Request-Id` and the plugin list has no `requestId()`, the function now serves each prerendered page, and the build log gives the reason. The check does the same for each other header that changes with each request.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `streamingCompress()` now parses `Accept-Encoding` only for a response that it can compress. A static file with a compressed copy, a 304, a HEAD response, and a body under 1 KiB no longer pay for the parse. No response changes.
  
  One parse takes about 205 ns for Safari's header and about 275 ns for Chrome's (Node.js 26.13, Apple M3 Max, 9 rounds of 1,000,000 calls). In process, with the default plugins and a `ResponseEdge`, as the node listener calls the server (7 processes, each with 9 rounds of 3,000 requests, `main` and this change in turn, on a machine with other load): a hashed asset with a brotli copy takes 0.978 of its time before (18.2 µs to 17.5 µs), a 304 0.973, a HEAD 0.989, and a small text file 0.985. A request with no `Accept-Encoding` takes the same time (0.969 to 1.013).

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The static stages now build the path of a compressed copy with no regular expression. Each static response, a 304 included, built two copy paths with an expression whose time grew faster than the length of the path. No response changes.
  
  One copy path takes 40 ns to 51 ns at each length. Before, it took 249 ns at 21 characters, about 630 ns at 39, and 2,115 ns at 96 (Node.js 26.13, Apple M3 Max, 11 rounds in turn of 1,000,000 calls). In process, with the default plugins and a `ResponseEdge` as the node listener calls the server (5 processes, each with 9 rounds of 3,000 requests, the build before and this change in turn): a hashed asset with a brotli copy takes 0.953 of its time before (16.2 µs to 15.5 µs), a prerendered page 0.966, a 304 0.948, an image 0.948, and a page at a file path of 96 characters 0.819 (24.3 µs to 19.9 µs).

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `cspNonce()` from `@ngrok/app-server/client` now gives the nonce of the request when the server has a `document` global. Before, it read the document and gave `undefined`, so `withRequestContext({ cspNonce }, …)` gave no nonce in a jsdom or happy-dom test, and a server with a DOM polyfill rendered each page with no nonce. In a request with no nonce, such as with no `contentSecurityPolicy` plugin, it gives `undefined` and does not read the document. Outside a request, it reads the document, as before. The browser build does not change.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `contentSecurityPolicy()` makes its nonce with less work. On Node.js, one `crypto.getRandomValues` call costs more than the rest of a nonce, and the plugin made one call for each request, assets included. It now gets the random bytes of 64 nonces with one call. Each nonce is still 16 bytes from `crypto.getRandomValues` in base64, and no two nonces share a byte. The bytes that no nonce took yet stay in the memory of the process.
  
  One caution is new. If you start more than one process from a copy of the memory of a process that already served a request, each process gives the same next nonces, 63 at most. Such a copy is an image of a virtual machine or a Node.js startup snapshot. A process holds no such bytes before its first request, so make the copy before that request.
  
  On Node.js v26.13, the stage went from about 1,200 ns to about 240 ns for each request, and from 1,517 to 876 bytes of garbage. With the option on, a request through the default plugins with no compression costs 6% to 15% less CPU time in the pipeline, for each kind of request. The numbers come from requests in one process with no socket: the median of 21 rounds that take turns between the build before and this one, in 3 runs.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `contentSecurityPolicy()` makes the `'self' 'sha256-…'` source list of each prerendered document one time, at startup. Before, its header hook made the list on each run, which is two times for a page with a compressed copy. On Node.js v26.13, one run of the hook on a document with 4 inline scripts costs about 23% less (about 850 ns to 650 ns) and leaves about 930 bytes less garbage: the median of 21 rounds that take turns between the build before and this one, in 3 runs. The policy does not change.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The build now writes the compressed copies of each React Router `.data` file of 1 kibibyte (KiB) or more: the gzip and the brotli copy on the node host, and the brotli copy on the vercel host. Before, the build read the type of a file from its extension alone, so a `.data` file got no copy. The server then compressed the file for each client navigation to a prerendered page. The server now sends the copy as it sends the copy of each other file: with a `Content-Length`, with an ETag for that encoding, and with no byte ranges.
  
  For a prerendered `.data` file of 12.4 KB through the pipeline of a React Router build, in process on Node.js 26.13 and macOS, with `Accept-Encoding: gzip, deflate, br, zstd` and 64 requests at a time: 19,164 requests per second become 31,661, the CPU time for each request goes from 125 to 53 microseconds, and the body goes from 464 to 388 bytes. Each number is the median of 5 runs of 20,000 requests, with the two builds in turn. On the vercel host, the function keeps only the brotli copy of such a file: for an app with 301 prerendered pages, of which 300 have a `.data` file of 12 KB to 13 KB, the client build in the function goes from 4.5 MB to 0.7 MB.
  
  The copies have a cost on the node host. The client build gets two more files for each `.data` file of 1 KiB or more, and the node host lists each file of the client build when the server starts. For the same app, the client build goes from 1,227 files to 1,829. `node build/server/app-server.js` then reaches the `listening` line in 95 ms in place of 89 ms, and its resident set size (RSS) at that time is 95.3 MB in place of 90.4 MB. Each number is the median of 61 runs, with the two builds in turn. The function of the vercel host gets no more files, because the brotli copy takes the place of the file. The build takes more time to write the copies: `react-router build` takes 1.67 s in place of 1.57 s on the node host, as the median of 21 builds.
  
  A framework adapter can give the build its content types: `FrameworkBuild` has a new optional `contentTypes` field, with the same value as `contentTypes` of the run side. `reactRouterAdapter()` sets it.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - In development, the server now makes the setup info of the plugins one time for each server entry, not for each request. The host's `files()` runs one time for an entry. A `setup` that throws still runs again on the next request.
  
  A development request through `defaultPlugins()` that Vite answers costs about 10% less CPU time in the pipeline: 10.1 µs to 9.3 µs. The numbers come from `fetchDev` in process, as the median of 21 interleaved rounds of 20,000 requests, on Node.js 26.13 and an Apple M3 Max.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On Node.js, the drain now ends when the last open response ends. Before, a keep-alive connection that had a request in flight when the drain began stayed open after its response. The server then answered each new request on that connection, waited for the whole `shutdownDeadlineMs` (10 s by default), and reset the request that was in flight at the deadline. So each deploy under load took the whole deadline, and an event stream from `eventStream()` held the drain open, although it closes at shutdown.
  
  Now each response that starts in the drain says `Connection: close`, and the server closes each connection when its last response ends. Bun and Deno already end the drain with the last response.
  
  The test ran on Node.js 26.13 with one request in flight on a keep-alive connection, a handler that answers 200 ms after the drain begins, and `shutdownDeadlineMs: 4000`. In 3 runs of each build, the drain took 4,001 to 4,002 ms before and 205 to 206 ms now.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The static stages now make the ETag of a file with no promise, and they keep the hash of more than one list of `etagPart` values. The text of each ETag stays the same, so a browser cache stays valid after the upgrade.
  
  - An app with a plugin that has an `etagPart` between two static stages, such as after `assets()`, gave its assets and its pages two lists of parts. The server kept the hash of one list, so each static response ran SHA-256 again. It now keeps the hash of up to 16 lists. In process, with a `ResponseEdge` as the node listener calls the server, an asset and a page in turn take 16.4 µs in place of 37.2 µs for each request (ratio 0.433; 5 processes, each with 9 rounds of 3,000 requests, the build before and this change in turn; Node.js 26.13, Apple M3 Max).
  - With the default plugins, a hashed asset with a brotli copy takes 0.975 of its time before, a 304 0.970, and an image 0.957 (the median of 3 runs, each with 7 processes, the same method). The asset allocates 0.9 KB less on the heap for each request (45.2 KB to 44.3 KB; 3 runs of 40,000 requests in one process for each build).
  - The ETag step of a response takes 147 ns in place of 671 ns (ratio 0.22). The time is for the functions of the built package, called as the stage calls them, for a request with two `etagPart` values (9 rounds in turn of 500,000 calls). In that step, the hex text of the modification time takes 44 ns in place of 350 ns for each file time (9 rounds in turn of 2,000,000 calls). On Bun 1.3, where one conversion of the time takes 30 ns, the hex text takes 54 ns, and the step takes 135 ns in place of 337 ns.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A `Cache-Control` in the `headers` option of `eventStream()` now goes out. Before, `eventStream()` dropped it and sent `no-cache`. A stream with no `Cache-Control` in `headers` still gets `no-cache`. If your `headers` have a `Cache-Control`, keep `no-cache` in it, or a cache can store the stream.
  
  So one stream can now opt out of compression: with `Cache-Control: no-cache, no-transform`, `streamingCompress()` and each proxy send the stream as it is. Why: a compressed stream holds its encoder until it ends, and a quiet feed that stays open saves few bytes for that memory.
  
  ```ts
  eventStream(produce, { signal: request.signal, headers: { "Cache-Control": "no-cache, no-transform" } });
  ```
  
  We measured 300 open streams of 3 events each on the node host with the default plugins, on Node.js 26.13 and an Apple M3 Max, 3 times each: the resident set size (RSS) of the process with the streams open, less the RSS before, for each stream.
  
  | `Accept-Encoding` | Default        | `no-transform`, before | `no-transform`, now |
  | ----------------- | -------------- | ---------------------- | ------------------- |
  | `gzip`            | 395 to 408 KiB | 406 to 432 KiB         | 68 to 70 KiB        |
  | `br`              | 675 to 713 KiB | 691 to 721 KiB         | 66 to 70 KiB        |
  
  A stream of a client that accepts no compression held 67 to 79 KiB. A quiet stream of 3 events took 751 bytes with `no-transform`, 570 bytes with gzip, and 558 bytes with brotli. The README section "Long-lived responses" now gives the memory of an open stream.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - In `eventStream()`, when the `data` of an event is not a string, `send()` now throws a `TypeError` that names the type, such as ``An event's `data` must be a string, not undefined.`` The usual cause is `JSON.stringify()`, which gives `undefined` for a value that it cannot write. Before, the error came from a string method, such as `data.split is not a function`. A `String` object went out before, and it also throws now.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `eventStream()` formats each event with less work, so `send()` takes less CPU time. On Node.js 26.13 on an Apple M3 Max, `send()` takes:
  
  - about 26% less time for an event with an `event` name and one line of JSON (375 ns to 276 ns)
  - about 28% less time for an event with only `data` (323 ns to 232 ns)
  - about 14% less time for an event with `event`, `id`, and three lines of data (484 ns to 417 ns)
  
  Each time is the median of 5 runs, and each percentage comes from the two times beside it. Each run has 151 interleaved rounds of 10,240 sends with the built package, against the build before the change. The bytes that go out for each event stay the same.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `eventStream()` no longer keeps the listeners that a producer leaves on `signal` after the stream ends by itself. Before, the runtime kept `signal`, each listener on it, and all that the listeners held, until the server stopped. So each stream that ended by itself, such as a progress feed, added memory that only a restart freed. In a test on Node.js 26.13, 200 streams whose producers each left one listener that held 1 mebibyte (MiB) kept 200 MiB after two garbage collections, and now keep 0 MiB (`process.memoryUsage().arrayBuffers`).
  
  The `signal` of a stream that ended no longer aborts when the request aborts or the server shuts down later. This shows on Deno, where the request aborts after each complete response: before, `signal` aborted after each stream that ended by itself, and now it does not. If a producer cleans up only in an `abort` listener, clean up when `produce` returns too.
  
  When the request aborts, a listener on `request.signal` now runs before `signal` aborts. Before, `signal` was aborted already.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `@ngrok/app-server` exports the types `StaticPage` and `CdnPage`. `staticPages()` of an `AppServerEntry` yields them, and an adapter could not name them before. The README section "Adapters" says what a host calls on the entry: `start`, `fetch`, `staticPages()`, and `stopPlugins()`.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The static stages now check a request path with no `split`. `prerendered()` checks the path of each GET and HEAD before it looks for a file, so each rendered page paid for two arrays and a string for each segment. No answer changes: the old and the new check agree on 3,009,331 generated paths.
  
  The check takes 54 ns in place of 206 ns (ratio 0.263; Node.js 26.13, Apple M3 Max, 15 rounds in turn of 2,000,000 calls, 6 paths). In process, with a `ResponseEdge` as the node listener calls the server (5 processes, each with 9 rounds, the build before and this change in turn): a request that goes on to the framework takes 0.976 of its time before with the default plugins (15.9 µs to 15.8 µs), and 0.955 at a path of 6 segments. With only `assets()` and `prerendered()`, it takes 0.914 (5.2 µs to 4.8 µs), and 0.857 at the longer path.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Two header hooks do less work on each run. The `buildId` hook no longer parses a `Server-Timing` header that the response does not have. The `Vary` check of `streamingCompress`, the static stages, and `noindex` no longer builds a `Set` to find one name.
  
  On Node.js v26.13, one run of the `buildId` hook on a document costs about 60 ns less (about 15%), and one `Vary` check costs about 100 ns less (about 40%). Each leaves about 300 bytes less garbage. A hook runs one to three times for each response. The numbers come from 21 to 31 rounds that take turns between the build before and this one. For a full request, the gain is inside the noise. No header changes.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `import "@ngrok/app-server"` now works on a runtime with no `process` global. Before, the import threw `ReferenceError: process is not defined` there, because the log code of the core set a `process.on("exit")` listener at load. So a host adapter for another runtime, such as Cloudflare Workers, could not load the core.
  
  The code that writes the log lines to standard output (stdout) is now part of the node host. `HostRuntime` has a new optional `logWriter` member, with `write(line)` and `flush()`. `jsonSink()` with no `write`, and the text lines of `app-server start`, go to the `logWriter` of the host. The node host and the vercel host give the writer that the core had. So on Node.js, Bun, Deno, and Vercel, a server writes the same lines in the same order: one write for the lines of one event-loop turn, each line on stdout before the process exits, and each line of a request on stdout before the vercel handler returns.
  
  Two things change:
  
  - Before `createEntry` runs, no host has given a writer, so `console.log` writes each line of `jsonSink()`, with one call for each line. This applies to a line that the app logs at module load, such as from `logger()`, and to a test that calls `app.fetch` with no entry. Before, these lines went to `process.stdout.write`, in one write for each turn. A test that reads them from a spy on `process.stdout.write` must spy on `console.log`, or give `jsonSink` a `write` function. `createTestServer` uses the node host, so its lines do not change.
  - A host adapter with no `logWriter` gets each line through `console.log` too. A host adapter on Node.js that needs the one write for each turn can give `logWriter: host.logWriter`, with the `host` of `@ngrok/app-server/node`.
  
  A line of the default sink on the node host costs the same: 621 ns against 628 ns for one access log line, with ratios of 0.99, 1.03, and 0.88 in three runs. Each run is the median of 5 samples of 200,000 lines for each build in turn, after one warm-up sample, with stdout to `/dev/null` (Node.js 26.13, macOS, Apple M3 Max). The spread between runs is larger than the difference.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Correct the JSDoc that an editor shows. No behavior changes.
  
  - `HeaderHook` and `withHeaderHook`: a hook that throws gets the answer of the app's `onError`. The JSDoc said that it always gives a 500.
  - `requestContext`: it also gives the client address. Its example now reads the request ID, because `logger()` is the function that logs outside a request too.
  - `contentSecurityPolicy`: the app gives `cspNonce()` from `@ngrok/app-server/client` to the framework's render.
  - `DefaultPluginsOptions`: `requestId`, `accessLog`, and `prerendered` have a description, and `securityHeaders` has its default.
  - `defaultPlugins` and `Plugin`: an app finds a plugin in the array by its `name`, such as `"streaming-compress"`.
  - `TcpOptions`: a `port` or a `host` wins over `PORT`, `HOST`, and the `--port` of `app-server serve`. The examples of `tcp` and `Listener` no longer set a port.
  - `redirects`: the default `trailingSlash` mode is `"preserve"`.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On Node.js, a stop no longer cuts a large response that still goes out to a slow client. Before, the server ended a body of one or two chunks at once, such as a large `c.json()` answer or a static file that it keeps in memory. Node.js counts such a response as done, and when the server stops, Node.js closes the connection of a done response with the bytes that its socket still holds. So a deploy cut the response, although the drain deadline had time left, and the access log said `http.client_aborted`.
  
  Now, when a body of one or two chunks is 64 KiB or more, the server ends it only after the socket takes it, so the drain waits for it, up to `shutdownDeadlineMs`.
  
  The test ran on Node.js 26.13 with a 32 MiB body of one chunk, a client that reads about 16 MiB each second, and a stop 150 ms after the request. In 3 runs of each build, the client got 3.8, 2.9, and 1.5 MiB before, and the whole 32 MiB now.
  
  The CPU time of the server for each request shows no change above the spread of the test. The numbers are medians of `process.cpuUsage()` for each request, with `oha` on 64 keep-alive connections, and the two builds in turn. Each test has a control route with a small body, which this change does not touch:
  
  - The entry script of the React Router fixture app on the node host, a brotli copy of 67,658 bytes: 46.6, 44.9, 49.9, and 57.4 µs before and 49.3, 45.4, 50.0, and 55.5 µs now, in 4 runs of 15 rounds of 30,000 requests. Each run has new server processes, and the numbers are in the order of the runs. The control, a page of 771 bytes: 37.5, 36.2, 38.7, and 44.6 µs before and 38.5, 36.3, 39.5, and 44.4 µs now.
  - A 200 KiB body of one chunk: 130.0 µs before and 132.2 µs now, in 11 rounds of 30,000 requests. The control, a body of 4 bytes: 27.5 µs before and 27.8 µs now.
  
  In the 4 runs of the first test, the entry script took from 3.3% less to 5.8% more CPU time than before, and its control took from 0.4% less to 2.7% more. So the test cannot show a change that is smaller than this spread.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `@ngrok/app-server/vite` no longer loads `@vercel/nft` at import. The server build loads it in the step that removes the files of a copied package that the build cannot load. So `vite dev`, `app-server start`, and a build with no package to trim do not load it. In a new Node.js 26.13 process on macOS, the import of `@ngrok/app-server/vite` now takes 18 ms in place of 49 ms, and the resident set size (RSS) grows by 9.6 MB in place of 23.9 MB. Each number is the median of 15 runs, with the two builds in turn.

- [#77](https://github.com/ngrok/app-server/pull/77) [`8ece79f`](https://github.com/ngrok/app-server/commit/8ece79f91011c85c881397e9dee4b8131079642a) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `accessLog` logs a 5xx whose client went away before the app answered as `499` at `info`, not as a 5xx at `error`. Why: React Router gives an aborted request a 500, so each client abort counted as a server error and could trigger a 5xx monitor. A 5xx whose body fails after the head still logs at `error`. The response does not change. An app that changed an aborted 500 to a 499 in its own plugin can remove that plugin.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The log now says when the drain deadline cuts open requests. Before, a shutdown that cut a response, such as a streamed answer that ran past `shutdownDeadlineMs`, logged only `draining` and `stopped`.
  
  - When the deadline passes and a listener still has open requests, the server logs one warn line: `the drain deadline passed with open requests`, with `app_server.deadline_ms`. When you see it, raise `shutdownDeadlineMs`, or stop the long responses on `shutdownSignal()`.
  - On Node.js, the access line of a response that the deadline cut now comes before the `stopped` line, with `http.aborted: true`. Before, the line came after `stopped`, and with the default `jsonSink()` the exit lost it.
  
  On Bun, a response that the deadline cuts still gets no access line. The exit code of such a shutdown is still 0.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A `log.attributes` or `log.error` hook that throws no longer stops the log call. Before, the throw left the log call: a route that called `logger().info()` answered 500, a request lost its access line, and a route that threw answered 500 with an empty body and no `unhandled error` line.
  
  Now the line goes out with `log.error`, such as `the attributes hook of the log option threw: <message>`, in place of the fields that the hook was to give. For `attributes`, that is each attribute of the line. For `error`, that is the fields of that error. The server does not write the fields that the hook got, because a hook can redact a value.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The production server no longer keeps the bytes of `.app-server.json` in memory after startup. It read the build manifest through the store of small files, which keeps each file up to 256 KiB for the life of the process, and no request reads the manifest again. The bytes also no longer count in the 32 MiB that the store allows.
  
  For a build with 302 prerendered paths, each server process and each Vercel Function instance now holds 110,250 bytes less, which is the size of that manifest. The number comes from `process.memoryUsage().arrayBuffers`, read after a garbage collection, before and after the setup, on Node.js 26.13.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The `prerendered paths with no file` warn line now has `app_server.missing_count`, and `app_server.missing_paths` names 20 of the paths at most. Before, the line had each path, so a server with no client build wrote each prerendered path of the site into one line.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The shutdown log now names the plugin whose `onShutdown` fails or hangs:
  
  - `plugin shutdown failed` has the name of the plugin as `app_server.plugin`, and it goes out when the hook fails. Before, a second plugin whose `onShutdown` hangs held the line back, and the exit at the deadline lost it.
  - `plugin shutdown passed the deadline` has `app_server.plugins`, the names of the plugins whose `onShutdown` is still open.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - If a middleware returns no `Response` and does not call `await next()`, the request has no answer. Such a request now gets the answer of the app's `onError` on each host. The header hooks run on that answer, and the access log writes its line. The default `onError` answers a 500 and writes one `unhandled error` line that says what a middleware must do. The same applies to a route and to a middleware that the app adds to the server with Hono, such as with `app.get()` and `app.use()`.
  
  Before, the answer depended on the host and on the plugin list:
  
  - Node.js and Vercel sent a 500. With `defaultPlugins()`, the log got up to six `TypeError` lines and no access line.
  - With some custom plugin lists, Bun, Deno, and `createTestServer` sent an empty 200 with no error line. An example is `[requestId(), plugin]`, in which a plugin with a header hook ran before the middleware. So a test with `createTestServer` passed for a plugin that failed each request in production.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On Node.js and Vercel, a response with no body now goes out with `Content-Length: 0`, such as each 308 of `trailingSlash` and `redirects`. Before, it went out with `Transfer-Encoding: chunked` and an empty chunk. That is 14 bytes less for each such response: the 308 of `GET /page/` is 340 bytes before and 326 bytes now, read from a raw socket. A HEAD response, a 204, and a 304 stay as they are. Bun and Deno already send `Content-Length: 0`.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The package no longer publishes source maps. The packed size goes from 321.7 kB to 149.4 kB, and the size on disk from 1,067.6 kB to 481.3 kB, in 72 files in place of 112. The numbers are `size`, `unpackedSize`, and `entryCount` from `npm pack --dry-run --ignore-scripts --json` after `pnpm run build`, not gzip of single files.
  
  A stack trace through the package now names the file in `dist`, such as `dist/create-server-<hash>.js:1275:10`. Before, with source maps on, as `app-server serve` sets them, it named a file that the package does not contain, such as `src/core/create-server.ts:71:10`. The files in `dist` are not minified.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A plugin with no `middleware` and no `etagPart`, such as one with only `setup` and `onShutdown`, no longer costs a pipeline stage for each request. The server gave each plugin a stage, and the stage of such a plugin only passed the request on.
  
  Each such plugin cost about 170 ns of CPU time for each request. With 11 of them and no other plugin, a request costs 4.36 µs before and 2.47 µs after in process, and 24.4 µs before and 22.5 µs after through the node listener over HTTP. Each number is the median of 21 interleaved rounds of 20,000 requests on Node.js 26.13 and an Apple M3 Max. An app with only `defaultPlugins()` sees no change, because each default plugin has a `middleware`.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - If the app's `onError` returns no `Response` for an error, such as from a handler with no last `return`, the client now gets a 500 with the body `Internal Server Error` on each host. The header hooks run on that 500, and the access log writes its line. The log gets an `unhandled error` line that names the handler, with the error in its `error.cause.*` fields. An error handler must return a `Response` for each error.
  
  Before, the answer depended on the host and on where the error came from:
  
  - For an error that a plugin or a route threw, Node.js and Vercel sent a 500 with no body and no log line, and the header hooks did not run. Bun, Deno, and `createTestServer` sent an empty 200, or failed the request.
  - For an error that a header hook threw, each host sent an empty 200.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The build check of `vercel({ cdnPages })` now compares the two bodies of each prerendered page with a loop. Before, it called a function for each byte. The check gives the same answer for each page.
  
  The compare of two equal bodies takes 39 µs in place of 292 µs at 40 KB, and 366 µs in place of 2,741 µs at 400 KB (ratio 0.13; Node.js 26.13, Apple M3 Max, 9 rounds in turn of 200 calls). The whole check of one page, with the default plugins, takes 109 µs in place of 287 µs at 40 KB (ratio 0.382, 500 pages), and 1.2 ms in place of 3.1 ms at 400 KB (ratio 0.405, 200 pages; 7 rounds in turn of `staticPages()` for each build in one process).

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A stage that only passes a request on no longer adds a promise to it. `withHeaderHook()` and the stages of `health`, `requestId`, `securityHeaders`, `bodyLimit`, `noindex`, `buildId`, `contentSecurityPolicy`, `trailingSlash`, and `privateDocuments` are now plain functions that return the promise of the next stage. `trailingSlash({ mode: "preserve" })` now has no `middleware`.
  
  On Node.js v26.13, a rendered page through the default plugins makes 98 promises, not 122, and a 404 from the framework leaves 35.7 KB of garbage, not 40.3 KB. A request that reaches the framework costs 3% to 7% less CPU time in the pipeline, and a static file 1% to 3% less. The times come from requests in one process with no socket and no compression, as on Vercel: the median of 31 rounds of 3,000 requests that take turns between the two builds, in 3 runs.
  
  This change alone needs no change in a plugin.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `createServer` now runs the plugins in one Hono middleware, not in one for each plugin. Each plugin, route, and error gets the same answer as before, with less work for each request. One case differs: an `etagPart` that throws a value that is not an `Error` now gets the answer of the app's `onError`, and the access log writes its line. Before, with a custom plugin list such as `[accessLog(), plugin]`, the access log wrote no line for that request, and the request failed when the plugin was the first in the list.
  
  Through `defaultPlugins()`, a request makes 24 fewer promises (110 before, 86 after, counted with `async_hooks`) and about 5 KB less garbage (42 KB before, 37 KB after). In process, the pipeline costs about 15% less CPU time: 8.7 µs before and 7.3 µs after with a framework that answers at once. Through the node listener over HTTP, the `/ping` route of the React Router fixture app costs 5% less server CPU time: 32.8 µs before and 31.2 µs after. A rendered page saves the same 1.4 µs, which is too small to measure: the 6 KB page of the fixture app costs 305 µs. Each time is the median of 21 or 31 interleaved rounds on Node.js 26.13 and an Apple M3 Max that ran other work at the same time.
  
  `matchedRoutes(c)` from `hono/route` now lists one `/*` route for all the plugins, not one for each plugin.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `prefersMarkdown()` now reads `Accept` with Hono's parser, which the server already uses for `Accept-Encoding`. For an `Accept` that names markdown, it takes about half the time: 1,421 ns to 781 ns for `text/markdown, text/html;q=0.9, */*;q=0.8`. The numbers are the medians of 11 interleaved rounds of 300,000 calls, with the build of `main` and this build in one Node.js 26.13 process. A browser's `Accept` names no markdown, so the server does not parse it, as before.
  
  One answer changes: a `charset` parameter with no value, such as `text/markdown;charset=""`, or with text after its closing quote, now counts as no charset, so the range matches. Before, the range did not match.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A build with a prerender pass no longer does its last step two times. With `appServer` after the framework's plugin, as the README shows, the build wrote the compressed copies of each prerendered file after the pass and again at the end. It also ran the host's `output` at both times, so `vercel({ cdnPages: true })` started the server build two times and printed its report two times. The build now does this work one time, at the end.
  
  For a React Router app with 301 prerendered pages on Node.js 26.13 and macOS, `react-router build` goes from 1.73 s to 1.67 s on the node host, and from 2.96 s to 2.39 s with `vercel({ cdnPages: true })`. Each number is the median of 21 builds, with the versions in turn. Each pair compares the build of the last release with a build that has three changes of this release: this one, the later load of `@vercel/nft`, and the copies of each `.data` file. Without those copies, the build takes 1.57 s on the node host and 2.20 s with `vercel({ cdnPages: true })`. The vercel numbers are from a build that wrote the gzip and the brotli copy of each file. On the vercel host, the build of this release writes fewer copies.
  
  On the node host, the build makes 1,210 compress calls, two for each of the 605 files that get copies, and none repeats an input. Before, the build made 1,216 calls for 304 files, so 608 calls repeated an input.
  
  For a host adapter: `output` of `HostBuild` now runs one time, after the build and the prerender pass. With `appServer` before the framework's plugin, the pass runs after the build, so `output` still runs after the build and again after the pass.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `prerendered({ headers })` also gets `file`, the URL path of the served file, such as `/about/index.html`. It is the path that `cacheControl` gets. `path` keeps its value: the path that names the file, such as `/about`. So a callback can now match each HTML page by its file:
  
  ```ts
  prerendered({
  	headers: ({ file }) => (file.endsWith(".html") ? { "CDN-Cache-Control": "max-age=300" } : undefined),
  });
  ```
  
  The docs of `headers`, `skip`, and `cacheControl` now say which path each one gets.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The node listener and `streamingCompress()` now look for the queued chunks of a body with a fixed wait of microtask turns, not a race of two promise chains. Each response body pays this 2 to 10 times. Each body gets the same answer at the same turn: 36 of 36 cases agree, for a read that settles or fails after 0 to 9 turns and for 16 kinds of stream. So the head, the chunks, and the time of the first byte of each response stay the same.
  
  Two looks at a new body with one queued chunk take 1,947 ns in place of 2,232 ns (ratio 0.872). One look adds 114 ns to a plain read in place of 257 ns, and the two looks make 24 promises in place of 28 (Node.js 26.13, Apple M3 Max, 11 rounds in turn of 200,000). In process, with the default plugins and a `ResponseEdge`, a rendered page that passes `streamingCompress()` takes 0.966 of its time before (15.3 µs to 15.2 µs in the medians; 7 processes, each with 9 rounds of 3,000 requests, the build before and this change in turn). A request with no `Accept-Encoding`, which needs no look there, takes 0.993. This run writes to no socket, so it does not hold the two looks of the node listener for each response.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Make the README agree with the code. No behavior changes.
  
  - The React Router example for a markdown twin gives `twinOf` the `{ path }` argument of 0.4.0. The old example had a type error. In JavaScript, it ran with no error and sent HTML for a markdown request.
  - The requirement is Node.js 26, not Node.js 26+, as `engines.node` is `^26.0.0`.
  - "The pipeline" gives the `name` of each default plugin, for a filter of `defaultPlugins()`, and the `ContextVariableMap` declaration that types an app's own context value.
  - "Logs" lists each line that the server writes, with its level and its attributes.
  - "Commands" says that a `port` or a `host` in `tcp()` wins over `--port`, `PORT`, and `HOST`.
  - "Adapters" names `createEntry`, `runtimeOptions`, the `name` of `FrameworkRuntime`, the rules of `output`, and the measured cost of the file list of `snapshot()`.
  - "Environment" names `env.values`, and "Long-lived responses" names the options of `eventStream()`.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Fix the auth example of the README section "Protect pages". The plugin compared the path with `startsWith("/app")`, and React Router and TanStack Router match a path in any letter case. So `/APP/settings` passed the check, and the framework rendered the page for a visitor with no session.
  
  If your app has a copy of the example, compare the lowercase path. Also keep a session check in each loader that reads private data, because the plugin protects only the paths that it names.
  
  ```ts
  // Before
  if (!c.req.path.startsWith("/app")) {
  // After
  if (!c.req.path.toLowerCase().startsWith("/app")) {
  ```

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `redirects()` no longer answers 500 when the target with the values of the request is not a URL. For example, with `{ from: "/go/*", to: "/*" }`, a request for `/go//%2F` makes the target `//%2F`, which names a host that no URL can have. Such a request now gets no redirect and goes on to the next stage, as each other request whose values break a check does.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `redirects()` costs less for a request that matches no rule, and its cost no longer grows with each pattern rule. Before, each GET parsed its URL and tested each rule with `:name` or `*` in turn. Now a request tests only the patterns that start with its first path segment, and the patterns whose first segment is `:name` or `*`. It parses its URL only when a rule can match its path, or when the path has a percent-escape or a part that a URL parse changes. The rule order and each match rule are the same.
  
  On Node.js v26.13, the stage for a page that matches no rule went from 305 ns to 148 ns with 200 exact rules, from 1,053 ns to 221 ns with 50 more pattern rules, and from 3,915 ns to 218 ns with 200 more. With 200 rules, a rendered page through the default plugins with no compression costs about 22% less CPU time in the pipeline. A request with a percent-escape in its path still parses its URL. With a table of exact rules only, that request costs about 30 ns more than before. The numbers come from 15 to 21 rounds that take turns between the build before and this one.
  
  Each redirect is the same as before for a request with a valid `Host` header. Two answers change, each for a GET or HEAD request whose URL the stage no longer parses.
  
  - A request whose URL does not parse, as with a `Host: 1.2.3.4.5` header, got a 500 from this stage. It now goes on to the next stage.
  - On Deno, the URL of a request has the `Host` header as the client sent it. With a `\`, a `?`, or a `#` in that header, the parsed URL has a different path: for `GET /` with `Host: a\old`, the path `/old/`. The request got the redirect of a rule that matches the parsed path. It now goes on to the next stage.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The package now exports the `RedirectsOptions` type, the options of `redirects()`, as it exports the options type of each other plugin. The type documents `trailingSlash` and its default, `"preserve"`. The README now says how a `redirects()` in your own plugin list takes the mode.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A `beforeStatic` plugin that sets `rewritesHtml` and changes a prerendered page now sends the page whole on each host. Before, the page kept the `Content-Length` of its file, so the new body did not match it. On the node host, a page under 1 KiB got a 500, and so did each page for a client with no gzip or brotli, or its body stopped early. On the vercel host, each page failed.
  
  With `rewritesHtml`, the static stages now send an HTML page with no `Content-Length`. They also send it with no ETag, and they answer an `If-None-Match` with the full page. Why: the server does not know which values the change depends on, so a 304 could keep a page that the plugin made with an old value. This rule does not apply to the pages of `runtimeEnv`, which keep their ETag and their 304.
  
  The plugin of the changelog (`c.set("rewritesHtml", true)`, then `c.res = addBanner(c.res)`) now gives the page with the banner in 18 of 18 cases, in place of 4 of 18: the node host and the vercel host, pages of 55 bytes, 2.9 KB, and 354 KB, and a client that accepts `identity`, `gzip`, or `br`.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `runtimeEnv` now adds the public values to an HTML document on its bytes. Before, it decoded each chunk of each document to text, searched all the text so far again for each chunk, and encoded the text again.
  
  - A document that is not UTF-8 keeps its bytes. Before, each byte that is not valid UTF-8 became U+FFFD, such as the `é` of an ISO-8859-1 page, and a UTF-8 byte order mark at the start of a document was lost.
  - An HTML body with no `</head>` now streams. Before, the server held the body until its end, or until 1 MiB of it. The server now holds only the end of a chunk that can start `</head>`, 6 bytes at most.
  - A UTF-8 document with no byte order mark gets the same bytes as before: 260 of 260 runs agree, for 20 documents at 13 chunk sizes. The search for `</head>` still stops after 1 MiB, which it now counts in bytes, not in characters.
  
  The transform alone, for one document, as the median of 3 runs of 31 rounds in turn (Node.js 26.13, Apple M3 Max, with other load on the machine):
  
  - A page of 40 KB in one chunk, with `é` and curly quotes in its text, takes 3.9 µs in place of 31.1 µs (ratio 0.12), and 3.6 KB of V8 heap in place of 172 KB. With only ASCII, where the decoder is fastest, it takes 4.3 µs in place of 6.7 µs (ratio 0.60).
  - A page of 250 KB in one chunk takes 13 µs in place of 279 µs, and 3.5 KB of heap in place of 936 KB.
  - 256 KB of HTML with no `</head>`, in chunks of 1 KB, takes 0.37 ms in place of 13.2 ms, and 0.3 MB of heap in place of 35 MB.
  
  In process, with the default plugins and a `ResponseEdge` as the node listener calls the server, for a first visit with public values (3 processes, each with 31 rounds in turn of 500 requests, the build before and this change):
  
  - With no compression streams, as on the vercel host: a prerendered page of 40 KB takes 0.89 of its time before (23.1 µs to 20.1 µs; 6 processes gave 0.84 to 0.93), a page of 400 KB 0.76, a page of 6 KB 0.96, and a rendered document of 6 KB the same time (1.00). A page of 36 KB whose head has 30 KB of inline CSS in ASCII, which is the case that helps the search least, takes 0.96.
  - On the node host, brotli takes most of the time: a page of 40 KB takes 0.98 (119 µs to 116 µs), and a page of 6 KB and a rendered document of 6 KB take the same time (1.01 and 0.99).
  - An asset and a data request take the same CPU time (1.00 and 1.01).

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A prerendered page now keeps its ETag when `runtimeEnv` has public values, so a repeat visit gets a 304 with no body. Before, `runtimeEnv` removed the ETag of each page that it changed. A page has `Cache-Control: public, max-age=0, must-revalidate`, so each visit got the full page, and the node host compressed it again.
  
  - The ETag has the public values, from the `etagPart` of `runtimeEnv`, and the size and the time of the file. A server with other values, and a file that changed, answer the old ETag with a 200 and the new page.
  - A rendered document still loses its ETag, because that ETag does not have the values.
  - A page with public values gets the ETag of the server, also when the `headers` option of `prerendered()` sets one.
  - `runtimeEnv` no longer sets the `rewritesHtml` request value. A page that a plugin with `rewritesHtml` also changes gets no ETag.
  
  In process, with the default plugins and a `ResponseEdge` as the node listener calls the server, a repeat visit to a page of 40 KB takes 12.9 µs in place of 137 µs on the node host (ratio 0.095), and sends no body in place of 2,249 bytes of brotli. With no compression streams, as on the vercel host, it takes 12.3 µs in place of 28.6 µs (ratio 0.445), and sends no body in place of 41,902 bytes. For a page of 400 KB, the ratios are 0.018 and 0.047 (16.8 µs in place of 933 µs, and 12.2 µs in place of 250 µs). Each number is the median of 3 runs of `main` and this change in turn in one process: 9 rounds of 2,000 requests, or 400 for the larger page (Node.js 26.13, Apple M3 Max, with other load on the machine).

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `app-server serve` no longer loads the CLI's own copy of the server for a build from the `appServer` plugin. Such a build runs on its own copy, so the CLI's copy only used time and memory. A plain React Router build, as in `app-server serve build/server/index.js`, still runs on the CLI's copy.
  
  On one build of a React Router app with 301 prerendered pages, with the CLI before and after this change, the time from the start of the process to the `listening` line goes from 104 ms to 92 ms, and the resident set size (RSS) at that time goes from 97.6 MB to 90.9 MB. `node build/server/app-server.js` takes 89 ms and 90.4 MB for that build. Each number is the median of 61 runs on Node.js 26.13 and macOS, with the commands in turn.
  
  An app that builds again with this release gets less of that gain. The build now writes two compressed copies of each `.data` file of 1 kibibyte or more. The node host lists each file of the client build when the server starts, so more files make the start slower. When the build also comes from the same version as the CLI, `serve` goes from 104 ms to 101 ms, and from 97.6 MB to 96.7 MB.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `app-server serve` now writes a message and the usage, with no stack trace, when no file is at the server build path. The process exits with code 1, as before.
  
  ```
  $ app-server serve nope/app-server.js
  No server build at nope/app-server.js. Build the app, or pass its path.
  Usage: app-server start [--port <port>] | app-server serve [--port <port>] [build/server/app-server.js]
  ```
  
  Before, a path with no file gave the runtime's module error with its stack, and `serve` with no path and no build gave the error message with a stack.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On a serverless host, such as Vercel, a request no longer waits for the setup after the setup ends. The entry's `fetch` waited for the promise of the setup through three promises on each request. Now the first request runs each plugin's `setup`, and each later request goes to the app at once. A `setup` that throws still runs again on the next request, and the log still gets the `setup failed` line.
  
  Each request makes 6 fewer promises: 165 before and 159 after through the Vercel handler with `defaultPlugins()`, counted with `async_hooks` for 5,000 requests on `node:http`. For an app with no plugins, `entry.fetch` in process costs 2.33 µs before and 2.13 µs after, as the median CPU time of 41 interleaved rounds of 30,000 requests on Node.js 26.13 and an Apple M3 Max. Through HTTP, the change in the CPU time of a request is less than the noise of the measurement, which is about 1%.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The README section "Adapters" now says how a serverless host of your own gets the log lines of a request to stdout before the platform freezes it. No behavior changes.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The server no longer keeps the setup info of the plugins in memory after setup. Before, three functions of the server kept it for the life of the process: the framework route, `trailingSlash()`, and `prerendered()`. The info holds the script hashes of each prerendered page, which only `contentSecurityPolicy()` reads, so each HTML file of the client build cost about 410 bytes of heap with no reader.
  
  We measured `heapUsed` after the first request and 6 garbage collections, less `heapUsed` after a warm-up setup, on the node host with `defaultPlugins()`, Node.js 26.13, and an Apple M3 Max. The client build was a build manifest with 4 hashes for each page. A new process ran each measurement, the build before the change and the build after it in turn, 3 times each. Each run gave the same number.
  
  | Pages  | Before   | After    |
  | ------ | -------- | -------- |
  | 100    | 252 KB   | 212 KB   |
  | 1,000  | 627 KB   | 232 KB   |
  | 10,000 | 4,381 KB | 261 KB   |
  
  With the `contentSecurityPolicy` option and 10,000 pages, the number goes from 7,281 KB to 3,552 KB, because that plugin keeps its own list of the hashes.
  
  A plugin of your own that uses `info` in its middleware keeps the info in the same way. Take the values that the middleware needs in `setup`, such as `const { files } = info`.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Each app server now has its own stop state and its own `shutdownSignal()`. Before, each `createServer` app of the process shared one pair, and each start of a server replaced the signal.
  
  - A `shutdownSignal()` that code read before the server started to listen now aborts at shutdown, such as a signal that a route module read at module load or that a plugin read in `setup`. Before, the start of the server replaced that signal, so it never aborted, and work that waited on it ran until the drain deadline. With two app servers in one process, it is the signal of only one of them, as the next item says.
  - In a request, and in work that the request started, `shutdownSignal()` is the signal of the app server that serves the request. Outside a request, and on a host with no request storage, it is the signal of the last `createServer` call, as the sink of `logger()` is.
  - With two app servers in one process, the shutdown of one no longer makes `/readyz` of the other answer 503, and no longer closes the `eventStream()` responses of the other. An event stream that one server opened before the other started now closes when its own server shuts down.
  - `app-server start` aborts the signal of each app server when it exits, also of an app server that an edit to `server.ts` replaced, as before. The edit alone aborts no signal.
  - In a test, an app from `createServer` answers `/readyz` with 200 after another server of the process shut down. Before, it answered 503.
  
  An app with one server that reads `shutdownSignal()` in a request sees no change.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On the node host, the server now lists the client build at start with at most 64 file system calls in flight. Before, it started a `stat` for each file and directory at one time, so a large site needed about 4 KiB of memory for each entry while it started. The list has the same entries.
  
  For a client build of 10,000 prerendered pages (71,004 files and directories), the list takes 497 ms in place of 582 ms (ratio 0.853), and the memory of the process grows by 92 MiB at its peak in place of 292 MiB (ratio 0.314). For 100 pages (1,704 entries), it takes 15.2 ms in place of 16.6 ms, and the memory grows by 8.3 MiB in place of 13.7 MiB. Two more runs of the 100 pages gave ratios of 1.013 and 1.014 for the time, so a small site starts as fast as before. Each number is the first `snapshot()` of a new process, as the median of 7 runs for each build in turn (Node.js 26.13, macOS, Apple M3 Max, with the files in the file cache). The time on Linux is not measured.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Two startup errors now name the file or the variable at fault:
  
  - **A `.app-server.json` that is not whole JSON**, such as a file that a copy cut short: `The server cannot read .app-server.json as JSON. Build the app again.` Before, the error was the one of the JSON parser, such as `Unterminated string in JSON at position 48`, with no file name.
  - **A `HOST` that the server cannot listen on:** `The server cannot listen on host "192.0.2.1", port 3000. The host is from the HOST environment variable.` The error of the runtime is the `cause`. Before, Node.js gave `listen EADDRNOTAVAIL: address not available 192.0.2.1`, Bun gave `Failed to start server. Is port 3000 in use?`, and Deno gave `Can't assign requested address`, with no word on `HOST`.
  
  A port in use keeps the error of the runtime on Node.js and Deno. On Bun, a port in use gets the new error when `HOST` is set, because Bun gives one error for both faults. A `host` that the app gives to `tcp()` keeps the error of the runtime. If your code reads `error.code` of a failed `start()`, read it from `error.cause` for the new error.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A failed start now writes one `startup failed` line to the log, with the level `error` and the `error.*` fields, before `start()` of the server entry rejects. A start fails when the setup throws, such as the `setup` of a plugin, or when a listener does not start, such as for a port in use or a bad `PORT`. The line goes to the `logger` sink of the app, through its `log` hooks. Before, the error went only to stderr, as the crash output of the runtime, with no level and no time.
  
  The crash output and the exit code 1 do not change. If your own entry catches the error of `start()` and logs it, the log now has two lines for one failure. If you alert on `error` lines, a crash loop now raises that alert.
  
  For a build from the `appServer` plugin, the copy of the package in the server build writes the line, so build the app again to get it.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `assets()` and `prerendered()` now build the headers of a file response one time. Before, a response made a `Headers` object from the defaults, made a second one in `prerendered()` for the captured headers and the `headers` option, read and wrote them about 12 times, and then copied them into the response. The headers of each response stay the same. A value of the `headers` option still loses the white space at its ends, a number still becomes text, and a value that no header can hold still gives a 500.
  
  In process, with the default plugins and a `ResponseEdge` as the node listener calls the server (5 processes, each with 9 rounds of 3,000 requests, the build before and this change in turn; Node.js 26.13, Apple M3 Max): a prerendered page with a brotli copy takes 0.885 of its time before, its 304 0.85, a hashed asset with a copy 0.90, its 304 0.855, an image 0.910, a byte range 0.876, and a HEAD 0.902. Other work loaded the machine, so the ratio of one process went from 0.63 to 1.19. The CPU time of the same runs gives 0.84 to 0.94 for each of these requests, and 0.977 for a request that goes on to the framework. The page allocates 3.4 KB less on the heap for each request (50.5 KB to 47.1 KB), and takes 21.0 µs to 22.7 µs of CPU time in place of 23.7 µs to 28.3 µs (3 runs of 40,000 requests in one process for each build).

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The `onShutdown` of a plugin can now return nothing, as `setup` can. Before, the type asked for a promise, so a cleanup with no `await`, such as `() => { clearInterval(timer); }`, needed `async`. The server already ran such a hook. Code that calls the `onShutdown` of another plugin must `await` the result, because it can be `undefined`.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `createTestServer` also takes the run side of a framework adapter as `framework`, such as `{ name: "test", fetch, isDataRequest: (path) => path.endsWith(".data") }`. A test can then set `isDataRequest` and `contentTypes`, so a data request gets its production headers, such as `Cache-Control: private, no-cache`. When the `buildId` option has a `value`, a data request also gets `X-Build-Id`, because a test server has no build ID of its own. Before, the test server had no data requests. The function form stays.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `trailingSlash()` costs less for a request that needs no redirect. It now tests the path before it lists the matched routes and parses the URL, which only a redirect needs. On Node.js v26.13, the stage went from about 600 ns to under 100 ns for each page request in the `never` mode, and from about 700 ns to about 150 ns in the `always` mode. A rendered page through the default plugins with no compression, as on Vercel, costs 3% to 7% less CPU time in the pipeline. The numbers come from requests in one process with no socket: the median of 21 to 31 rounds that take turns between the build before and this one.
  
  Each redirect is the same as before for a request with a valid `Host` header. Two answers change, each for a GET or HEAD request whose URL the stage no longer parses. That is a request whose path already has the form of the mode, and whose last path segment does not end with a `.` or a `\`.
  
  - A request whose URL does not parse, as with a `Host: 1.2.3.4.5` header, got a 500 from this stage. It now goes on to the next stage.
  - On Deno, the URL of a request has the `Host` header as the client sent it. With a `\` in that header, the parsed URL has a different path: for `GET /` with `Host: a\b`, the path `/b/`. The request got the redirect for the parsed path, a 308 to `/b` in the `never` mode. It now goes on to the next stage.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On the vercel host, the build now writes only the compressed copies that the deploy holds: the brotli copy of each file that the function serves, and no copy of a file that the CDN serves (a file under `cdnPaths` or Vite's `build.assetsDir`). Before, the build also made a gzip copy of each text file and both copies of each CDN file, and `vercel()` then left them out of `.vercel/output`.
  
  Each comparison in this note is between two builds that differ only in this change. Both builds have the compressed copies of each React Router `.data` file, which are new in this release. So no comparison in this note is with the last release.
  
  This change alone does not change the deploy, except in one rare case: for each file of the client build, `.vercel/output` of the two builds holds the same file or the same copy with the same bytes. `build/client` no longer holds a `.gz` copy or a copy of a CDN file.
  
  The rare case is a file whose brotli copy is smaller than the file and not smaller than its gzip copy. The build now keeps a brotli copy when it is smaller than the file. Before, it kept the copy only when it was also smaller than the gzip copy. So for such a file, the function now holds the brotli copy in place of the file and its gzip copy.
  
  For a React Router app with 1,000 prerendered pages (an HTML file of 28 KB and a `.data` file of 12 KB for each page), `react-router build` with `vercel()` spends 656 ms in `gzipSync` and `brotliCompressSync` in place of 1,162 ms, which is 0.56 of the time. So the build saves about 0.5 s for each 1,000 pages. Each number is the median of 5 builds of each version in turn, after one warm-up build, on Node.js 26.13 and macOS, from a preload script that times the two functions. `build/client` holds 2,001 copies (10.1 MB) in place of 4,008 (21.0 MB), and `.vercel/output/static` and the client build in the function have the same SHA-256 in the two builds.
  
  On the node host, the two builds write the same copies with the same bytes, in the same time: 1,124 ms and 1,130 ms in zlib, the median of 3 builds.
  
  For a host adapter: `HostBuild` has a new optional `copies` member. It gets the URL path of a file of the client build and the URL path of Vite's `build.assetsDir`, and it gives the encodings of the compressed copies that the host reads, such as `["br"]`. The build writes no other copy of that file. With no `copies`, the build writes the gzip and the brotli copy.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On the vercel host, a cold start of the function now reads one list of the files of its client build. Before, it read each directory and called `stat` for each file, and the time grew with each prerendered page, also for a page that the CDN serves.
  
  `vercel()` writes the list to `.app-server-files.json` in the function's client build, in place of `.app-server-brotli.json`. The list has the size of each file that the function holds and the time of the build. The responses do not change: each file has the same headers, and its ETag still changes with each build.
  
  For a React Router app with 2,000 prerendered pages (4,003 files in 2,002 directories in the function), the first request of a cold start takes 20 ms in place of 82 ms, which is 0.24 of the time. The function calls `stat` 1 time in place of 6,006 times, and `readdir` 0 times in place of 2,002 times. The second request takes 1.5 ms in place of 0.7 ms, because a garbage collection that ran in the first request now runs in the second. From the third request on, a request takes the same time. Each number is the median of 11 runs of each build in turn, each run in a new process, after 2 warm-up runs (Node.js 26.13, macOS, Apple M3 Max, with the files in the file cache). Six such rounds gave ratios from 0.22 to 0.25 for the first request. The time on Vercel is not measured. The four file lookups of one page request take 235 ns in place of 985 ns. The list adds 122 KB to that function.
  
  The build step of `vercel()` takes each size from its own walk of the client build, so it calls `statSync` 10,055 times in place of 14,056 times for that app. Its time does not change by an amount that we can measure: 3 rounds of 15 runs of each build in turn gave ratios of 1.00, 0.97, and 0.97 for the median.
  
  Three things change for an app:
  
  - The function serves only the files that `vercel()` put in it. If a step after the build adds a file to `.vercel/output/functions/index.func`, the function does not serve that file. Before, it did.
  - `.vc-config.json` has no `environment`, and the function no longer gets the `APP_SERVER_BUILT_AT` variable. The time of the build is in the list.
  - The function's client build has `.app-server-files.json` and no `.app-server-brotli.json`.
  
  The node host does not change.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `vercel({ cdnPages })` now writes its report of the paths that the function serves through the logger of the Vite build, so Vite's `logLevel` and `customLogger` apply to it. With a `logLevel` of `warn`, `error`, or `silent`, the report does not print. The report now names each path with its reason, as the README says. Before, it went to stdout and named the first 20 paths, so the reason for path 21 was in no file and in no log.
  
  With `appServer` before the framework's plugin, the build prints the report two times, as before: one time before the prerender pass, and one time after it. The last report is the correct one.
  
  For a host adapter: `HostOutput` has a new `logger` field, the logger of the Vite build, for what the host's `output` prints. After a prerender pass it is still the logger of the build, not the logger of the framework's preview server, which is silent for React Router.

- [#78](https://github.com/ngrok/app-server/pull/78) [`88332de`](https://github.com/ngrok/app-server/commit/88332deac37444693dd4803a30418742cd146068) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - A production server whose client build is not there now says so. At startup, it writes one warn line, `client build not found`, with the directory as `app_server.client_directory`. Before, the server started with only `listening`, and each asset got a 404, such as in a Docker image that copied only the server build. The server still starts, because an app can keep its client build on a CDN. A directory with no files gives no line.

## 0.4.1

### Patch Changes

- [#71](https://github.com/ngrok/app-server/pull/71) [`1828a19`](https://github.com/ngrok/app-server/commit/1828a190a716a975627f5bccc44a80bf5cba4531) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - An own `kind` field of an error no longer replaces `error.kind`, so `error.kind` is always the error's name. A field that a `log.error` hook gives no longer replaces another attribute of the line, such as the request's `http.method`. The `log.attributes` hook runs last and can still change each field.

## 0.4.0

### Minor Changes

- [#68](https://github.com/ngrok/app-server/pull/68) [`e327e78`](https://github.com/ngrok/app-server/commit/e327e785b4d43a5d172f564d064c6dbc78bc6e1e) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Logging: one error format, a logger outside a request, and hooks to change each line.
  
  - An attribute whose value is an `Error` becomes dotted fields under its name: `kind`, `message`, `stack`, each own field, such as `code`, the `cause` chain as `<name>.cause.*`, and the members of an `AggregateError` as `<name>.errors`. The server's own error lines, such as `unhandled error`, now also write `error.cause.*` and the error's own fields.
  - `jsonSink()` and `textSink()` write a bigint as a string, such as `"1n"`, and a cycle as `"[Circular]"`. A log call no longer throws for its attributes.
  - `jsonSink()` writes each line about 40% faster: it no longer copies the attributes into a new object.
  - `logger()` gives the logger of the request that runs. Outside a request, it writes to the sink and hooks of the last `createServer` call, else to `jsonSink()`. The default logger of `appServerContext` outside a request now writes there too.
  - The `log` option of `createServer` takes two hooks: `attributes` changes the attributes of each line, and `error` gets the default fields of each error and gives the fields to write.
  - Breaking: the request fields of a request's log line (`http.request_id`, `http.method`, `http.url_details.path`, and `logAttributes`) now win over a field of the same name that the caller gives. Before, the caller's field replaced them. To write your own value, use another name, or change it in the `log.attributes` hook.
  - Breaking: each callback of a public option and the `LogSink.log` method now take one object with named fields, not positional arguments. Change each one as follows:
  
    ```ts
    // Before
    logger: { log: (level, message, attributes) => … }
    accessLog({ attributes: (c, sent) => … })
    prerendered({ headers: (path, c) => …, rewrite: (path, c) => … })
    prerendered({ markdownTwins: { twinOf: (path, c) => … } })
    contentSecurityPolicy({ policy: (scriptSrc, c) => … })
  
    // After
    logger: { log: ({ level, message, attributes }) => … }
    accessLog({ attributes: ({ context, sent }) => … })
    prerendered({ headers: ({ path, context }) => …, rewrite: ({ path, context }) => … })
    prerendered({ markdownTwins: { twinOf: ({ path, context }) => … } })
    contentSecurityPolicy({ policy: ({ scriptSrc, context }) => … })
    ```

## 0.3.6

### Patch Changes

- [#65](https://github.com/ngrok/app-server/pull/65) [`7b6ef54`](https://github.com/ngrok/app-server/commit/7b6ef5412f4cc17c3687189b3b7d1101a80a8227) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On the node host, `streamingCompress()` now picks the brotli window from the size of the body. A body over 256 kibibytes (KiB) gets a window of 4 mebibytes (MiB), so a page that repeats data more than 256 KiB back is smaller. A body that ends within 256 KiB keeps the window of 256 KiB, and it now compresses in one zlib call. To pick the window, the stream holds the start of a body until the body ends, goes past 256 KiB or 1,024 chunks, or waits for its next chunk. So a page shell that waits for slow data still goes out at once.

## 0.3.5

### Patch Changes

- [#60](https://github.com/ngrok/app-server/pull/60) [`4be601a`](https://github.com/ngrok/app-server/commit/4be601a925c6c832a6be8efd4b5ac7fff1fbc172) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `streamingCompress()` sends brotli with a 256 KiB window, not 4 MiB, on the node host. Why: Node.js tells V8 the full window of each open encoder, and under load V8 then runs a full garbage collection for every few responses. A rendered page of 19 KB to 67 KB under brotli now gets the same requests per second as under gzip, with about 30% more requests per second than before. A page under 256 KiB gets the same bytes, and a page of 2.7 MB gets about 5% more. Fixes [#59](https://github.com/ngrok/app-server/issues/59).

- [#60](https://github.com/ngrok/app-server/pull/60) [`4be601a`](https://github.com/ngrok/app-server/commit/4be601a925c6c832a6be8efd4b5ac7fff1fbc172) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `streamingCompress()` joins the chunks that a body has queued up to 64 KiB, not 16 KiB. Each zlib write costs a trip to the thread pool. So a rendered page of 19 KB that the body queues at once now costs one zlib call, not three. On the node host, that page under brotli gets 23% more requests per second and 39% less CPU for each request. The source can now be read up to 64 KiB ahead of the client.

- [#61](https://github.com/ngrok/app-server/pull/61) [`93e9aea`](https://github.com/ngrok/app-server/commit/93e9aeae2324efd1fffad6e4fc4b015d521d0401) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `app-server start` prints its URLs as `vite dev` does, in place of a JSON `listening` line:
  
  ```
    ➜  Local:   http://localhost:3000/
    ➜  Network: http://192.168.4.33:3000/  en0
  ```
  
  When the host is every interface, such as `server.host: true`, it prints a `Network` line for each IPv4 (Internet Protocol version 4) interface. Each URL ends with Vite's `base`. The lines go through Vite's logger, so Vite's `logLevel` and `customLogger` apply.
  
  The other log lines of `start`, such as a port in use or a failed request, use the text format of Go's `log/slog`, not JSON:
  
  ```
  time=2026-11-11T16:50:44.050Z level=INFO msg="port in use, trying the next port" server.port=3333
  ```
  
  `app-server serve` and the production server still write JSON.

## 0.3.4

### Patch Changes

- [#57](https://github.com/ngrok/app-server/pull/57) [`857a228`](https://github.com/ngrok/app-server/commit/857a228226a00d91017b64847cb8e607bca446a5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The server and the build now compress more types. `streamingCompress()` compresses them, and the build writes a `.gz` and a `.br` copy of such a static file. The new types are each type with a `+json` or `+xml` suffix (such as `application/rss+xml`, `application/atom+xml`, and `application/ld+json`), `image/x-icon`, `image/vnd.microsoft.icon`, `image/bmp`, `font/ttf`, `font/otf`, `application/vnd.ms-fontobject`, `application/wasm`, `application/yaml`, `application/x-yaml`, and `application/x-sh`. For example, a browser asks for `favicon.ico` on each first visit, and the icon now gets a compressed copy. `font/woff` and `font/woff2` are compressed already and stay as they are.

- [#57](https://github.com/ngrok/app-server/pull/57) [`857a228`](https://github.com/ngrok/app-server/commit/857a228226a00d91017b64847cb8e607bca446a5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The static stages now send the type that `express.static` sent for more file extensions. Before, such a file went out as `application/octet-stream`, so a browser downloaded it, and the server did not compress it:
  
  - `.sh`: `application/x-sh`
  - `.yaml` and `.yml`: `text/yaml; charset=utf-8`
  - `.rss`: `application/rss+xml`
  - `.atom`: `application/atom+xml`
  - `.pem`: `application/x-pem-file`

- [#57](https://github.com/ngrok/app-server/pull/57) [`857a228`](https://github.com/ngrok/app-server/commit/857a228226a00d91017b64847cb8e607bca446a5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `streamingCompress()` now sends brotli, at quality 4, to a client whose `Accept-Encoding` ranks `br` at least as high as `gzip`, as each browser does. Before, a rendered page always got gzip. Brotli at quality 4 is smaller for the same CPU time: a page of 149 KiB takes 0.60 ms and 7.7 KiB as brotli, and 0.68 ms and 10.6 KiB as gzip. It still flushes after each chunk. On the node host, a page that ends with its first chunk, up to 64 KiB, takes a pooled brotli encoder, as gzip does. On Bun and Deno, each brotli body takes a new encoder, because a reset encoder there loses its quality or gives no bytes.
  
  `HostRuntime` and `SetupInfo` have a new optional `brotli` stream, next to `gzip`. The node host gives both, on Node.js, Bun, and Deno. A host with no `brotli` stream sends gzip, as before.

- [#57](https://github.com/ngrok/app-server/pull/57) [`857a228`](https://github.com/ngrok/app-server/commit/857a228226a00d91017b64847cb8e607bca446a5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The server build now copies only the files of an external package that the build can load. Before, it copied each external package whole, with each of its installed dependencies. The build traces the server build with `@vercel/nft`, with the export conditions of Node, Bun, and Deno, and removes each other copied file, such as a source map or a dependency that the package bundled into its own file. For `@vercel/og` 1.0.1, the copy goes from 42.9 MB to 23.6 MB.
  
  Some packages still keep each file: a native package and each package that it depends on, a package in `ssr.external`, and a package that the app gives to `require.resolve()` or `import.meta.resolve()`. Two new `appServer` options change the copy:
  
  - `externals.whole`: packages that keep each file, for a package that reads a file whose path the trace cannot find.
  - `externals.omit`: packages that the build does not copy, such as an optional dependency that a package loads in a `try`. With `appServer({ externals: { omit: ["sharp"] } })`, the copy for `@vercel/og` is 3.0 MB, and `@vercel/og` uses `resvg.wasm`.

- [#57](https://github.com/ngrok/app-server/pull/57) [`857a228`](https://github.com/ngrok/app-server/commit/857a228226a00d91017b64847cb8e607bca446a5) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On the `vercel` host, the function now keeps only the `.br` copy of a client-build file that has one. Before, it kept the file, its `.gz` copy, and its `.br` copy, and each one counted toward Vercel's 250 MB function limit. For a blog with 265 prerendered pages, that makes the function about 50 MB smaller. A client that accepts brotli gets the copy, as before. For any other client, the function decompresses the copy, and Vercel's CDN compresses the response.

## 0.3.3

### Patch Changes

- [#50](https://github.com/ngrok/app-server/pull/50) [`266acd7`](https://github.com/ngrok/app-server/commit/266acd737b8915fd77663b8f941df044d0f6860b) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `accessLog()` changes three things:
  
  - A line with a 5xx status has the level `error`, so Datadog shows the request as an error, and a monitor on error logs finds it. A line with another status keeps the level `info`.
  - With React Router, a line has the route pattern that the request matched as `http.route`, such as `/domains/:domainId`. A request that matches no route has no `http.route`. A framework adapter gives the pattern with `c.set("routePattern", pattern)`.
  - In development, a request that Vite answers, such as a source module, a CSS file, or `/@vite/client`, gets no line. The dev terminal shows the requests that the app answers.

- [#50](https://github.com/ngrok/app-server/pull/50) [`266acd7`](https://github.com/ngrok/app-server/commit/266acd737b8915fd77663b8f941df044d0f6860b) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `assets()` and the `vercel` host use Vite's `build.assetsDir`. The `appServer` Vite plugin records its URL path in `.app-server.json`, so the hashed files get `Cache-Control: public, max-age=31536000, immutable` wherever `build.assetsDir` puts them. With `build.assetsDir: "blog-assets/build"`, `/blog-assets/build/*` gets the immutable cache, and on Vercel the CDN serves it with no `cdnPaths` entry. A build from an earlier version keeps `/assets/`.
  
  A host's `output` also gets `assetsPath`, the URL path of `build.assetsDir`.

- [#50](https://github.com/ngrok/app-server/pull/50) [`266acd7`](https://github.com/ngrok/app-server/commit/266acd737b8915fd77663b8f941df044d0f6860b) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The build writes the compressed copies (`.<file>.gz` and `.<file>.br`) only inside the client build. Before, a directory link in the client build, such as `build/client/blog-assets` to `public/blog-assets`, got the copies in the link's target. A link and a file in a linked directory now get no copy. The server compresses such a file for each request, as it does for any file with no copy.

- [#50](https://github.com/ngrok/app-server/pull/50) [`266acd7`](https://github.com/ngrok/app-server/commit/266acd737b8915fd77663b8f941df044d0f6860b) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `defaultPlugins({ noindex })` and `noindex()` take `unlessHeader`. A request with this header gets no `X-Robots-Tag`, and each response gets the header in `Vary`, so a CDN keeps one answer for each case. For example, to allow indexing only for a request through the ngrok edge:
  
  ```ts
  defaultPlugins({ noindex: { unlessHeader: "x-ngrok-edge" } });
  ```
  
  On the `vercel` host with `cdnPages`, the CDN serves a prerendered page and picks the answer by the header. `noindex: true` still sets `X-Robots-Tag: noindex, nofollow` on each response.

- [#50](https://github.com/ngrok/app-server/pull/50) [`266acd7`](https://github.com/ngrok/app-server/commit/266acd737b8915fd77663b8f941df044d0f6860b) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - `securityHeaders()` takes `Permissions-Policy`, with no default. A response that has its own `Permissions-Policy` keeps it:
  
  ```ts
  defaultPlugins({
  	securityHeaders: { headers: { "Permissions-Policy": "camera=(), microphone=(), geolocation=()" } },
  });
  ```

- [#50](https://github.com/ngrok/app-server/pull/50) [`266acd7`](https://github.com/ngrok/app-server/commit/266acd737b8915fd77663b8f941df044d0f6860b) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Under `app-server start`, a Vite plugin gets the CLI's HTTP server as `server.httpServer` in its `configureServer` hook, also when the hook has `order: "pre"`. Before, Vite's middleware mode gave `null`, so a plugin that waits for `listening` or `close` did nothing, with no error. A Vite restart keeps the server open, so to clean up for each plugin instance, use Vite's `closeServer` hook.

- [#50](https://github.com/ngrok/app-server/pull/50) [`266acd7`](https://github.com/ngrok/app-server/commit/266acd737b8915fd77663b8f941df044d0f6860b) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - On the `vercel` host, `vercel({ cdnPages: true })` lets Vercel's CDN serve each public prerendered page, so a page view does not run the function. The default is `false`, so an app that does not set the option gets no change.
  
  ```ts
  appServer({ host: vercel({ cdnPages: true }) });
  ```
  
  After the build, `vercel()` starts the server build once and sends each prerendered path through the pipeline. The CDN serves a page when the answer is a 200 from its file, has no cookie and no `private`, `no-store`, or `no-cache`, and is the same for a second client. The second client has another host, address, and query, and it sends a cookie, `Authorization`, `Accept-Language`, and Vercel's geo headers. So a page behind an auth check, or a page that a plugin answers another way for a signed-in visitor or a country, stays in the function. The CDN sends the pipeline's body and headers, so the security headers, the CSP, and the build ID do not change. If the pages need more than Vercel's 2,048 routes, the function serves the rest. The build log names each path that the function serves, with the reason.
  
  With the option on:
  
  - The build runs each plugin's `setup`, so it needs the app's environment.
  - A page that the CDN serves writes no access log line and sends no `X-Request-Id`. The build's requests write no access log line.
  - A page with a `$` in a response header stays in the function, because a Vercel route reads `$1` or `$name` in a header as a capture.
  - The function still keeps the page's file, for a request that no CDN route matches, such as `/about/` for `/about`.
  
  A function keeps each path that it refuses in the function: `vercel({ cdnPages: (path) => path !== "/" })`. With `trailingSlash: "always"`, the CDN serves `/blog/` for the prerendered path `/blog`, so a page that the function refuses in either form stays in the function.

- [#50](https://github.com/ngrok/app-server/pull/50) [`266acd7`](https://github.com/ngrok/app-server/commit/266acd737b8915fd77663b8f941df044d0f6860b) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - The README and the JSDoc of `vercel({ maxDuration })` say that a route module's `config` export, such as `export const config = { maxDuration: 60 }`, does nothing on the `vercel` host. One function serves each route, so `regions`, `memory`, and `maxDuration` apply to each request.

## 0.3.2

### Patch Changes

- [#38](https://github.com/ngrok/app-server/pull/38) [`185cdda`](https://github.com/ngrok/app-server/commit/185cddafa46ce6a4c217068a34587fb0dca4cf09) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - Add `@ngrok/app-server/testing`, for the tests of an app:
  
  - `createTestServer({ app, files, framework })` starts the app in production mode over a client build of `files`, with no listener. It records the hashes of the inline scripts of each HTML file, as the build does, so a test can check the CSP of a prerendered page.
  - `withRequestContext(values, work)` runs `work` with `requestContext()` and `cspNonce()` set to `values`, so a render test needs no mock.
  
  The `bindings` argument of a `FetchHandler`, such as the entry's `fetch`, is now optional.
  
  ```ts
  const server = await createTestServer({ app, files: { "providers/index.html": html } });
  const response = await server.request("/providers");
  await server.close();
  
  const rendered = await withRequestContext({ cspNonce: "test-nonce" }, () => renderToString(<App />));
  ```

- [#38](https://github.com/ngrok/app-server/pull/38) [`185cdda`](https://github.com/ngrok/app-server/commit/185cddafa46ce6a4c217068a34587fb0dca4cf09) Thanks [@cody-dot-js](https://github.com/cody-dot-js)! - With `markdownTwins: true`, a request that `rewrite` changes gets no twin. `rewrite` sends that request to another file or to the framework, so it gets the same answer as a browser. An app no longer repeats its `rewrite` rule in `twinOf`:
  
  ```ts
  prerendered({
  	rewrite: (path, c) => (path === "/" && new URL(c.req.url).search !== "" ? "/index.html" : path),
  	markdownTwins: true,
  });
  ```
  
  `/?q=h100` gets no twin, and `/gpu/h100` gets `/gpu/h100.md`. A custom `twinOf` still decides for each request. `rewrite` now runs for each request, also for a request that gets the twin.

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
