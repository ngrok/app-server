---
"@ngrok/app-server": minor
---

On Node.js and Vercel, the server writes each response itself, not through the writer of `@hono/node-server`, and it runs the header hooks on the head that it writes, so it copies no response for them. In a one-process A/B on Node.js with `oha` at 64 connections, a small route, a prerendered page, a hashed asset, and a rendered 6 KB page with gzip each answer 13% to 17% more requests each second.

- A body that ends within the chunks that it has queued goes out with its `Content-Length`, in one socket write with the head. A gzip page whose body has ended goes out in one write too.
- A streamed page no longer waits for a timer before its shell goes out. This delay hit each streamed page sent without gzip, such as on Vercel.
- A body that fails, or that ends before its `Content-Length`, closes the connection, so no client and no cache keeps a cut response as complete. Before, a body that failed before the head went out as a complete 200 with the bytes read so far.

Breaking change for a plugin: a header hook of `withHeaderHook` runs once where the response leaves, after the code that each stage runs after `next()`. So code after `await next()` no longer sees the headers that the hooks of later stages set. Read or change the final headers in a hook:

```ts
// Before
middleware: async (c, next) => {
	await next();
	record(c.res.headers.get("X-Request-Id"));
},
// After
middleware: async (c, next) =>
	withHeaderHook(c, next, (headers) => {
		record(headers.get("X-Request-Id"));
	}),
```

For a listener adapter: a listener that writes each response itself can give each request an `edge` binding, a `ResponseEdge`. The server then gives it the header hooks to run on the head, and the access log takes the body bytes from it.
