---
"@ngrok/app-server": patch
---

On Node.js, a `fetch()` result in a route is now an `instanceof Response`. The listener no longer replaces the global `Response`, in `serve` and in `start`. This matches Bun and Deno, and small responses are faster. The listener still replaces the global `Request`, so `new Request(c.req.raw)` copies a request.
