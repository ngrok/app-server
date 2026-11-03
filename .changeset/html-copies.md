---
"@ngrok/app-server": minor
---

The `appServer` Vite plugin now also writes the gzip and brotli copies of each HTML page, and `app-server serve` sends them. The server no longer compresses a prerendered page for each request. On Node.js, a 392 kilobyte (KB) page answers about 21,000 requests each second with `Accept-Encoding: gzip, br`, up from about 2,200.

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
