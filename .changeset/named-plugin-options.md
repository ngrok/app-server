---
"@ngrok/app-server": minor
---

`defaultPlugins()` now puts each opt-in plugin in its correct place, so an app does not need to know the order. Use these options:

- `health`: on by default. `false` turns it off.
- `buildId`: on by default, with the ID of the client build. `false` turns it off.
- `contentSecurityPolicy`: the options of `contentSecurityPolicy()`.
- `env`: the plugin from `runtimeEnv(schema)`.
- `noindex`: `true` turns it on.

These plugins see every response, prerendered pages included. `beforeStatic` stays for the app's own plugins, such as an auth check. They go after the plugins of the options, so they get the CSP nonce, and their responses get the headers of those plugins.

Breaking changes:

- With `defaultPlugins()`, each document and data response now gets `X-Build-Id` and the `build` metric in `Server-Timing`.
- Two plugins of one named option now stop startup, such as `buildId()` in `beforeStatic` next to the default `buildId`. One would replace the headers of the other, so the value that the app gave would be lost. Move the plugin to its option.

Before:

```ts
defaultPlugins({ beforeStatic: [env, buildId({ value: env.values.PUBLIC_APP_VERSION })] });
```

After:

```ts
defaultPlugins({ env, buildId: { value: env.values.PUBLIC_APP_VERSION } });
```

Or remove `buildId` to send the ID of the client build.
