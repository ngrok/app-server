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
