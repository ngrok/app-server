---
"@ngrok/app-server": patch
---

A plugin list with a function now stops startup, and the `Plugin` type rejects a function. Before, the compiler took a Hono middleware, or a plugin factory that the app did not call, as a plugin, and the server started and never ran it. For example, `defaultPlugins({ beforeStatic: [basicAuth({ username, password })] })` sent each page with no auth check.

The error names the entry and the fix:

```
plugins[7] is the function basicAuth, not a plugin. Call a plugin factory, such as requestId(). Put a Hono middleware in a plugin, such as { name: "auth", middleware: basicAuth() }.
```

Each other entry that is not an object, such as `false` from `condition && plugin`, also stops startup. To add a plugin on a condition, spread a list: `...(condition ? [plugin] : [])`.
