---
"@ngrok/app-server": minor
---

On Node.js and Vercel, the server writes each response itself, not through the writer of `@hono/node-server`. It runs the header hooks on a list of the headers that it writes, so it copies no response for them. In a one-process A/B on Node.js with `oha` at 64 connections, a small route, a prerendered page, a hashed asset, and a rendered 6 KB page with gzip each answer 13% to 17% more requests each second.

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
- The static stages and `streamingCompress()` also run the hooks on a view of the headers, to read the `Cache-Control` that leaves. So a hook runs two or three times for a response with gzip or a compressed copy, rendered pages included. Each run must give the same headers, and a hook must do nothing else, such as log, count, or store a value. A `policy` of `contentSecurityPolicy()` and the `paths` of `buildId()` run in a hook too.
- A hook that throws gives a 500, as a stage that throws does.
- `accessLog({ attributes })` gets what went out as its second argument: the status, the headers after the hooks, the bytes, and whether the body stopped early. Read a response header there, such as `attributes: (c, sent) => ({ cache: sent.headers.get("Cache-Control") })`, not from `c.res`, which can lack the changes of the hooks.

For a listener adapter: a listener that writes each response itself can give each request an `edge` binding, a new `ResponseEdge`. The server keeps the headers after the hooks in the edge, and the access log takes its line from the report of the listener. See the README.
