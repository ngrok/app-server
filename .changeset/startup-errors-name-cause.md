---
"@ngrok/app-server": patch
---

Two startup errors now name the file or the variable at fault:

- **A `.app-server.json` that is not whole JSON**, such as a file that a copy cut short: `The server cannot read .app-server.json as JSON. Build the app again.` Before, the error was the one of the JSON parser, such as `Unterminated string in JSON at position 48`, with no file name.
- **A `HOST` that the server cannot listen on:** `The server cannot listen on host "192.0.2.1", port 3000. The host is from the HOST environment variable.` The error of the runtime is the `cause`. Before, Node.js gave `listen EADDRNOTAVAIL: address not available 192.0.2.1`, Bun gave `Failed to start server. Is port 3000 in use?`, and Deno gave `Can't assign requested address`, with no word on `HOST`.

A port in use keeps the error of the runtime on Node.js and Deno. On Bun, a port in use gets the new error when `HOST` is set, because Bun gives one error for both faults. A `host` that the app gives to `tcp()` keeps the error of the runtime. If your code reads `error.code` of a failed `start()`, read it from `error.cause` for the new error.
