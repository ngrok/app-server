---
"@ngrok/app-server": patch
---

Correct the JSDoc that an editor shows. No behavior changes.

- `HeaderHook` and `withHeaderHook`: a hook that throws gets the answer of the app's `onError`. The JSDoc said that it always gives a 500.
- `requestContext`: it also gives the client address. Its example now reads the request ID, because `logger()` is the function that logs outside a request too.
- `contentSecurityPolicy`: the app gives `cspNonce()` from `@ngrok/app-server/client` to the framework's render.
- `DefaultPluginsOptions`: `requestId`, `accessLog`, and `prerendered` have a description, and `securityHeaders` has its default.
- `defaultPlugins` and `Plugin`: an app finds a plugin in the array by its `name`, such as `"streaming-compress"`.
- `TcpOptions`: a `port` or a `host` wins over `PORT`, `HOST`, and the `--port` of `app-server serve`. The examples of `tcp` and `Listener` no longer set a port.
- `redirects`: the default `trailingSlash` mode is `"preserve"`.
- `nodeFiles`: the measured cost of the file list of `snapshot()`.
