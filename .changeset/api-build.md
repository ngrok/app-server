---
"@ngrok/app-server": minor
---

Breaking changes to the build side of the package: the `/vite` and `/react-router` entries, and the adapter contracts `FrameworkBuild` and `HostBuild`. An app that uses `appServer()`, `node()`, `vercel()`, `reactRouterAdapter()`, and `tanstackStartAdapter()` as the README shows needs no change for them. One change reaches the environment of a deploy: see the first item.

**A bad `TRUST_FORWARDED_PROTO` or `TRUSTED_PROXY_HOPS` now stops startup.** For a build with no `server.ts`, these variables set `trustForwardedProto` and `trustedProxyHops`. Before, `TRUST_FORWARDED_PROTO=true` left the option off with no error and no log line. Behind a proxy that ends TLS, the server then sent no `Strict-Transport-Security` header and gave the app an `http:` request URL. `TRUSTED_PROXY_HOPS=1e2` counted as 100 proxies, and `TRUSTED_PROXY_HOPS=abc` failed with a message about `trustedProxyHops` and `NaN`.

- `TRUST_FORWARDED_PROTO` takes `1` or `0`.
- `TRUSTED_PROXY_HOPS` takes an integer of 0 or more.
- For each of them, no value and an empty value keep the default.
- Each other value stops startup with a message that names the variable, the value, and the fix. This includes a value with a space or a carriage return, such as `" 1"`, which `TRUSTED_PROXY_HOPS` took before. The message shows the value as JSON, so a hidden character shows as `"1\r"`.

```sh
# Before: the server starts, and does not trust X-Forwarded-Proto.
# After: the server stops with this message.
# TRUST_FORWARDED_PROTO must be "1" or "0", not "true". Set TRUST_FORWARDED_PROTO=1 to trust X-Forwarded-Proto, or remove the variable.
TRUST_FORWARDED_PROTO=true app-server serve

# The fix: the server starts, and trusts X-Forwarded-Proto.
TRUST_FORWARDED_PROTO=1 app-server serve
```

Check the environment of each deploy of a build with no `server.ts` before you upgrade. This also applies to the vercel host: a bad value there fails the `cdnPages` step of the build, or each request to the function. In `app-server start`, the first request shows the message.

**Four exports that only the package used are gone.**

- `SERVER_ENTRY_ID` and `serverEntrySource` from `@ngrok/app-server/vite` have no replacement. The entry now exports only `appServer` and its types.
- `isServerBuild` from `@ngrok/app-server/react-router`: call `runtime()`, which throws for a module that is not a React Router server build.
- The type `AppServerContext` from `@ngrok/app-server/react-router`: use `RequestContext` from `@ngrok/app-server`, which is the same type.

```ts
// Before
import type { AppServerContext } from "@ngrok/app-server/react-router";

// After
import type { RequestContext } from "@ngrok/app-server";
```

`app-server serve` with a module that is not a server build still stops at startup. Its message is now `The server module is not a React Router server build.`

**`FrameworkBuild` and `HostBuild` have no `name`.** No log and no error read it. Delete `name` from the object of a custom adapter. TypeScript reports each one in a typed object literal.

**`HostBuild` has no `entryFileName`.** The server entry is `app-server.js` in the server build on each host, which is where `app-server serve` looks for it. `node()` and `vercel()` gave that name already. A custom host that gave another name now gets `app-server.js`, also in plain JavaScript, where no type error shows it. Such a host must read `entryFile` in its `output`, or write its own file there, as `vercel()` writes `vercel-function.js`.

A custom host before and after these two changes:

```ts
// Before
appServer({ host: { name: "edge", runtimeModule: "edge-host", entryFileName: "app-server.js" } });

// After
appServer({ host: { runtimeModule: "edge-host" } });
```

**`FrameworkBuild` has no `validate`.** The `appServer` plugin now checks Vite's `base` itself, for each framework adapter. Before, each adapter of the package made the check, so a custom adapter with no `validate` built with a `base` other than `/`, and the server then served at `/` only. Such a build now fails with `@ngrok/app-server serves a build at "/" only`. The plugin no longer calls `validate`, also in plain JavaScript, where no type error shows it. To check the Vite config, add a Vite plugin with a `configResolved` hook.

```ts
// Before
appServer({ framework: { ...adapter, validate: (config) => check(config) } });

// After
plugins: [{ name: "my-check", configResolved: (config) => check(config) }, appServer({ framework: adapter })];
```
