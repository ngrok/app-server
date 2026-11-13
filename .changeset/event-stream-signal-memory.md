---
"@ngrok/app-server": patch
---

`eventStream()` no longer keeps the listeners that a producer leaves on `signal` after the stream ends by itself. Before, the runtime kept `signal`, each listener on it, and all that the listeners held, until the server stopped. So each stream that ended by itself, such as a progress feed, added memory that only a restart freed. In a test on Node.js 26.13, 200 streams whose producers each left one listener that held 1 mebibyte (MiB) kept 200 MiB after two garbage collections, and now keep 0 MiB (`process.memoryUsage().arrayBuffers`).

The `signal` of a stream that ended no longer aborts when the request aborts or the server shuts down later. This shows on Deno, where the request aborts after each complete response: before, `signal` aborted after each stream that ended by itself, and now it does not. If a producer cleans up only in an `abort` listener, clean up when `produce` returns too.

When the request aborts, a listener on `request.signal` now runs before `signal` aborts. Before, `signal` was aborted already.
