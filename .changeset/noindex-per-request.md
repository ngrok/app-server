---
"@ngrok/app-server": patch
---

`defaultPlugins({ noindex })` and `noindex()` take `when` and `vary`, so an app can decide for each request. `when` gets the Hono context. The plugin adds each header in `vary` to `Vary` on each response, so a CDN keeps one answer for each value:

```ts
defaultPlugins({
	noindex: { when: (c) => c.req.header("x-ngrok-edge") == null, vary: ["x-ngrok-edge"] },
});
```

`noindex: true` still sets `X-Robots-Tag: noindex, nofollow` on each response.
