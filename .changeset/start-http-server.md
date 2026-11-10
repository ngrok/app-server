---
"@ngrok/app-server": patch
---

Under `app-server start`, a Vite plugin gets the CLI's HTTP server as `server.httpServer` in its `configureServer` hook, also when the hook has `order: "pre"`. Before, Vite's middleware mode gave `null`, so a plugin that waits for `listening` or `close` did nothing, with no error. A Vite restart keeps the server open, so to clean up for each plugin instance, use Vite's `closeServer` hook.
