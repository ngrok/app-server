---
"@ngrok/app-server": patch
---

Add the `health()` plugin and the `shutdownDelayMs` option of `createServer`. `health()` answers `/livez` with 200, and `/readyz` with 200 until the server gets a stop signal, then 503. With `shutdownDelayMs`, the listeners serve on for that time after the signal, so a load balancer removes the server before the drain starts. The drain deadline starts after the delay. `health()` is not in `defaultPlugins()`: put it first, with `[health(), ...defaultPlugins()]`.
