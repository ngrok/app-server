---
"@ngrok/app-server": patch
---

If a middleware returns no `Response` and does not call `await next()`, the request has no answer. Such a request now gets the answer of the app's `onError` on each host. The header hooks run on that answer, and the access log writes its line. The default `onError` answers a 500 and writes one `unhandled error` line that says what a middleware must do.

Before, the answer depended on the host:

- Node.js and Vercel sent a 500. When an earlier plugin returned the promise of `next()`, as most plugins of `defaultPlugins()` do, the log got up to six `TypeError` lines and no access line.
- Bun, Deno, and `createTestServer` sent an empty 200 with no error line when a plugin with a header hook, such as `requestId()`, ran before the middleware. So a test with `createTestServer` passed for a plugin that failed each request in production.
