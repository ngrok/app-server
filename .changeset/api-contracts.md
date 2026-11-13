---
"@ngrok/app-server": minor
---

Breaking changes to the contracts of a plugin, a host adapter, and a listener. An app that uses only `createServer`, `defaultPlugins()`, and the adapters of this package changes nothing for the first four.

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

**`@ngrok/app-server/node` no longer exports `devServerStage`, `DevServerStageOptions`, and `NodeMiddleware`.** Only `app-server start` used them, and they have no replacement. A server build on the node host holds the code of each export of this module, so it loses the dev server stage and the script hash code. The module in a server build goes from 97,403 to 88,523 bytes before minification, and from 28,210 to 25,059 bytes with gzip. Measured as a Vite SSR bundle of `import * as hostModule from "@ngrok/app-server/node"` with `ssr.noExternal`, as the generated server entry imports it. A build on the vercel host does not change.
