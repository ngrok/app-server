---
"@ngrok/app-server": patch
---

If a middleware returns no `Response` and does not call `await next()`, the request has no answer. Such a request now gets the answer of the app's `onError` on each host. The header hooks run on that answer, and the access log writes its line. The default `onError` answers a 500 and writes one `unhandled error` line that says what a middleware must do. The same applies to a route and to a middleware that the app adds to the server with Hono, such as with `app.get()` and `app.use()`.

Before, the answer depended on the host and on the plugin list:

- Node.js and Vercel sent a 500. With `defaultPlugins()`, the log got up to six `TypeError` lines and no access line.
- With some custom plugin lists, Bun, Deno, and `createTestServer` sent an empty 200 with no error line. An example is `[requestId(), plugin]`, in which a plugin with a header hook ran before the middleware. So a test with `createTestServer` passed for a plugin that failed each request in production.
