---
"@ngrok/app-server": minor
---

Breaking changes to the install and to the contracts of a plugin, a host adapter, and a listener. The first change is for each app. The others are for an app with a plugin that logs in `setup`, a host or a listener of its own, or an import of a removed export.

**`hono` is a peer dependency (`^4.13.16`), not a dependency.** The app and the package now share one copy of Hono, and the server runs on the app's version. Before, the package had its own copy at one pinned version (4.13.14 in 0.4.1), and an app with another version got a second copy. TypeScript then refused a middleware of the app's copy, such as `cors()` from `hono/cors`, as the `middleware` of a plugin, and it refused `app.route("/api", new Hono())`.

The install line of the README stays `pnpm add -E @ngrok/app-server hono`. The app must have `hono` 4.13.16 or later:

```sh
# An app with no `hono` of its own, or with `hono` below 4.13.16
pnpm add -E hono
```

pnpm, npm, and Bun install a peer that the app does not have. Yarn does not, and pnpm with `auto-install-peers=false` does not.

We measured an empty app with the install line of the README, when the latest Hono was 4.13.18 and the package pinned 4.13.16. The app had 2 versions of Hono and 3 type errors before, and it has 1 version and 0 errors now. The server build of a React Router app whose `server.ts` imports `cors()` held two copies of Hono before, and it holds one now: the JavaScript in `build/server` goes from 1,821,793 to 1,761,656 bytes.

**`info.logger` in the `setup` of a plugin is a logger with one method for each level**, as `logger()` and `c.get("logger")` are. Before, it was the sink. TypeScript reports each call. In JavaScript, the old call throws when it runs.

```ts
// Before
info.logger.log({ level: "warn", message: "cache is cold", attributes: { "cache.entries": 0 } });
// After
info.logger.warn("cache is cold", { "cache.entries": 0 });
```

**`HostRuntime` and `Listener` have no `name`.** No log and no error read it. Delete `name` from a host or a listener of your own. TypeScript reports each one.

```ts
// Before
const listener: Listener = { name: "unix", start };
// After
const listener: Listener = { start };
```

**`HostRuntime.listeners` is a list, not a function**, as the `listeners` option of `createServer` is. TypeScript reports the old form. In JavaScript, a host that still gives a function fails at start with `This app server has no listener`. The docs of `HostRuntime.lifecycle` now say that a host with `listeners` must give a lifecycle, else a stop signal ends the process with no drain.

```ts
// Before
export const host: HostRuntime = { files, listeners: () => [tcp()], lifecycle };
// After
export const host: HostRuntime = { files, listeners: [tcp()], lifecycle };
```

**`@ngrok/app-server` no longer exports `PUBLIC_ENV_SCRIPT_ID`, `RunningServer`, and `FrameworkRuntimeFactory`.** No public function used the two types. Browser code could not import the constant, because the import pulled the server into the client bundle.

- For `PUBLIC_ENV_SCRIPT_ID`, write the ID: `document.getElementById("app-server-public-env")`.
- For `FrameworkRuntimeFactory`, declare the function: `runtime(serverModule: unknown, options: { mode: Mode }): FrameworkRuntime`. Add the fields of your `runtimeOptions` to `options`.
- `RunningServer` has no replacement.

**`@ngrok/app-server/node` no longer exports `devServerStage`, `DevServerStageOptions`, and `NodeMiddleware`.** Only `app-server start` used them, and they have no replacement. A server build on the node host holds the code of each export of this module, so it loses the dev server stage and the script hash code. A build on the vercel host does not change.

- Without them, the module in a server build is about 9 kB smaller before minification, and about 3 kB smaller with gzip.
- The module no longer loads `node:http` and `node:crypto` at import. On Bun 1.3.14, the import of the module takes about 8.4 ms, not 12.7 ms. On Deno 2.9.8, it takes about 14.6 ms, not 18.7 ms.
- On Node.js, the time to `listening` does not change, because the listener of `tcp()` loads `node:http` when it starts.

We measured a Vite SSR bundle of `import * as hostModule from "@ngrok/app-server/node"` with `ssr.noExternal`, as the generated server entry imports it. For the time, a new process imported the bundle. Each time is the median of 40 interleaved runs after 5 warm-up rounds, on an Apple M3 Max.
