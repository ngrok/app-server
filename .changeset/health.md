---
"@ngrok/app-server": minor
---

Add the `health()` plugin and the `shutdownDelayMs` option of `createServer`. `health()` answers `/livez` with 200. It answers `/readyz` with 200, and with 503 after a stop signal. With `shutdownDelayMs`, the server serves requests for that time after the signal, so the load balancer removes it before the drain. The drain deadline starts after the delay.

`defaultPlugins()` runs `health()` first, so a probe skips the access log. The `health` option takes its options, such as a `ready` check:

```ts
defaultPlugins({ health: { ready: async () => db.ping() } });
```

Breaking change: with `defaultPlugins()`, the server now answers `/livez` and `/readyz`, and an app route at those paths no longer runs. Remove the app's route, or set `health: false` to keep it.
