---
"@ngrok/app-server": patch
---

`tcp({ idleTimeoutMs })` now takes a value above 299 s on Node.js, such as `620_000` behind a load balancer that keeps idle connections for 600 s. Before, such a value stopped startup with an error about `headersTimeout`. For such a value, the server also raises the request timeout of Node.js from 300 s to the idle timeout plus 1 s.

`tcp()` now checks `idleTimeoutMs` when the app calls it. A value that is not an integer from 0 to 2147482647 throws an error that names the option and the value, on Node.js, Bun, and Deno.

The README and the JSDoc now say what each runtime does with the option: Node.js keeps an idle connection for this time. Bun counts whole seconds, 255 at most, and also closes a response that sends no bytes for this time. Deno has no idle timeout, so the option has no effect there.
