# @ngrok/app-server

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
