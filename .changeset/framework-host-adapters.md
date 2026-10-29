---
"@ngrok/app-server": minor
---

The server now works with more than one framework and host. A framework adapter connects the framework. A host adapter decides where the server runs. The package has a React Router adapter, a TanStack Start adapter, and a `node` host adapter. The `node` host runs on Node, Bun, and Deno.

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
