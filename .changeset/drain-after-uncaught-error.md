---
"@ngrok/app-server": patch
---

The node host now drains after an uncaught error, then exits with code 1. An uncaught error is an error that no code catches, such as a rejected promise with no handler in a route. Before, the runtime stopped the process at once: each open request lost its connection, and the log had no line for the error, only the runtime's text on standard error (stderr).

- The server logs one error line, `uncaught exception`, with the fields of the error. `app_server.origin` is `uncaughtException` or `unhandledRejection`. On Node.js, the line also has the fields of the request that the error came from, such as `http.request_id`.
- The server then stops as it does on `SIGTERM`: `/readyz` answers 503, the server waits for `shutdownDelayMs`, and it drains until `shutdownDeadlineMs`. So the exit comes later than before, by up to the sum of the two times.
- The exit code is still 1. The server drains for the first uncaught error only: a later one can stop the process at once, as before.
- An app with its own `uncaughtException` listener that kept the process alive now stops after the drain. On Bun, the same is true for an `unhandledRejection` listener. On Node.js and Deno, an app's own `unhandledRejection` listener still handles a rejected promise, and the server does not stop.

This applies to `app-server serve` and `node build/server/app-server.js` on Node.js, Bun, and Deno. `app-server start` and the vercel host do not change.

Measured on Node.js 26.13, Bun 1.3.14, and Deno 2.9.8, with two runs for each runtime before and after: a 400 ms request was open when a route left a rejected promise with no handler. Before, the open request failed on each runtime, and the process exited 9 to 26 ms after the error, with 13 to 18 lines on stderr. Now the open request completes on each runtime, and the process exits with code 1 after 360 to 362 ms, with one JSON error line and no line on stderr.
