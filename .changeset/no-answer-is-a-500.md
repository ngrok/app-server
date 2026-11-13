---
"@ngrok/app-server": patch
---

A stage that returns no `Response` and does not call `await next()` gives a request no answer. Such a request now gets the answer of the app's `onError`, a 500 by default, on each host. The header hooks run on that answer, and the log gets an `unhandled error` line that says what a middleware must do.

Before, Node.js and Vercel sent a 500. Bun, Deno, and `createTestServer` sent an empty 200 with no log line when a plugin with a header hook, such as `requestId()`, ran before the stage. So a test with `createTestServer` passed for a plugin that failed each request in production.
