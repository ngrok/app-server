---
"@ngrok/app-server": patch
---

If the app's `onError` returns no `Response` for an error, such as from a handler with no last `return`, the client now gets a 500 with the body `Internal Server Error` on each host. The header hooks run on that 500, and the access log writes its line. The log gets an `unhandled error` line that names the handler, with the error in its `error.cause.*` fields. An error handler must return a `Response` for each error.

Before, the answer depended on the host and on where the error came from:

- For an error that a plugin or a route threw, Node.js and Vercel sent a 500 with no body and no log line, and the header hooks did not run. Bun, Deno, and `createTestServer` sent an empty 200, or failed the request.
- For an error that a header hook threw, each host sent an empty 200.
