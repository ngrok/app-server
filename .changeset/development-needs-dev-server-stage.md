---
"@ngrok/app-server": minor
---

In `app-server start`, a plugin list with no `assets()` now fails each request with this error:

```
No plugin runs the dev server, so Vite serves no source module, HMR client, or CSS. Add assets() to the plugin list.
```

Before, the page rendered, but each request for a Vite module, the HMR client, or a CSS file got the 404 of the framework, with no log line that said why. `assets()` is the plugin that runs Vite in development.

This is a breaking change for an app that gives its own plugin list with no `assets()`, such as `defaultPlugins().filter((plugin) => plugin.name !== "assets")`. Add `assets()` to the list:

```ts
// Before
createServer({ plugins: [requestId(), accessLog(), prerendered()] });

// After
createServer({ plugins: [requestId(), accessLog(), assets(), prerendered()] });
```

A plugin of your own that reads `info.devServer` in its `setup` and runs it also passes. `defaultPlugins()` has `assets()`, and production does not change. A test that calls `fetchDev` of a server entry needs the same change.
