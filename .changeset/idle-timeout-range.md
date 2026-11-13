---
"@ngrok/app-server": minor
---

`tcp({ idleTimeoutMs })` now takes a value above 299 s on Node.js, such as `620_000` behind a load balancer that keeps idle connections for 600 s. Before, such a value stopped startup with an error about `headersTimeout`. For such a value, the server also raises the request timeout of Node.js from 300 s to the idle timeout plus 1 s.

`tcp()` now checks `idleTimeoutMs` when the app calls it. A value that is not an integer from 0 to 2147482647 throws an error that names the option and the value, on Node.js, Bun, and Deno.

Breaking: on Bun and Deno, a value that is not an integer from 0 to 2147482647 now stops startup. Before, Bun started with a value such as `Infinity`, `1.5`, or the string `"95000"`: it rounded the value up to whole seconds and used 255 s at most. Deno started with each value, because it does not use the option. Pass an integer from 0 to 2147482647. For example, change `idleTimeoutMs: Infinity` to `idleTimeoutMs: 255_000` on Bun, and change a string from the environment to a number. On Node.js, such a value already stopped startup.

The README and the JSDoc now say what each runtime does with the option: Node.js keeps an idle connection for this time. Bun counts whole seconds, 255 at most, and also closes a response that sends no bytes for this time. Deno has no idle timeout, so the option has no effect there.
