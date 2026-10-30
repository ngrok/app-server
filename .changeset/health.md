---
"@ngrok/app-server": patch
---

Add the `health()` plugin and the `shutdownDelayMs` option of `createServer`. `health()` answers `/livez` with 200. It answers `/readyz` with 200, and with 503 after a stop signal. With `shutdownDelayMs`, the server serves requests for that time after the signal, so the load balancer removes it before the drain. The drain deadline starts after the delay. `health()` is not in `defaultPlugins()`, so put it first: `[health(), ...defaultPlugins()]`.
