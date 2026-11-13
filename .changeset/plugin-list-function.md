---
"@ngrok/app-server": minor
---

`createServer` now stops startup for an entry of the plugin list that is not a plugin: a function, a list, a promise, or a value that is not an object. The `Plugin` type now rejects a function. Before, the compiler took a Hono middleware, or a plugin factory that the app did not call, as a plugin, and the server started and never ran it. For example, `defaultPlugins({ beforeStatic: [basicAuth({ username, password })] })` sent each page with no auth check.

The error names the entry and the fix:

```
plugins[7] is the function basicAuth, not a plugin. Call a plugin factory, such as requestId(). Put a Hono middleware in a plugin, such as { name: "auth", middleware: basicAuth() }.
```

Breaking change: a Hono middleware in the plugin list now stops startup. Before, the server started and never ran the middleware. Put the middleware in a plugin.

```ts
// Before
defaultPlugins({ beforeStatic: [basicAuth({ username, password })] });

// After
defaultPlugins({
	beforeStatic: [{ name: "auth", middleware: basicAuth({ username, password }) }],
});
```

Breaking change: a plugin factory that the app does not call now stops startup. Before, the server started without the plugin. Call the factory.

```ts
// Before
createServer({ plugins: [requestId, accessLog] });

// After
createServer({ plugins: [requestId(), accessLog()] });
```

Breaking change: an entry that is not an object, such as `false` from `condition && plugin`, now stops startup. Before, the server skipped `false`, a string, or a number. To add a plugin on a condition, spread a list.

```ts
// Before
createServer({ plugins: [...defaultPlugins(), isDebug && debugHeaders] });

// After
createServer({ plugins: [...defaultPlugins(), ...(isDebug ? [debugHeaders] : [])] });
```

Breaking change: a list of plugins as one entry, such as `defaultPlugins()` with no spread, now stops startup. Before, the server started and ran no plugin of that list. Spread the list.

```ts
// Before
createServer({ plugins: [defaultPlugins(), auth] });

// After
createServer({ plugins: [...defaultPlugins(), auth] });
```

Breaking change: a promise of a plugin, such as the result of an `async` plugin factory with no `await`, now stops startup. Before, the server started without the plugin. Wait for the plugin.

```ts
// Before
defaultPlugins({ beforeStatic: [loadAuth()] });

// After
defaultPlugins({ beforeStatic: [await loadAuth()] });
```

Breaking change: a function with a `middleware` field of its own now stops startup, as each function does. So does an object with a `then` function, which the server takes as a promise. Before, the server ran the `middleware` of both. Give the plugin as an object with no `then` field.

```ts
// Before
const auth = Object.assign(() => {}, { middleware: basicAuth({ username, password }) });

// After
const auth = { name: "auth", middleware: basicAuth({ username, password }) };
```

Breaking change for TypeScript: the `Plugin` type has a new `call?: never` field, which a function cannot meet. So the compiler also rejects a plugin object that has a `call` field. Give that field another name.

A `plugins` option that is not a list, such as `defaultPlugins` with no call, stopped startup before too. Its error now names the fix.
