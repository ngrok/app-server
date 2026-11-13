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
