---
"@ngrok/app-server": minor
---

Breaking change: `appServer({ app })` with a path to no module now stops `app-server start` when it starts, with an error that names the path and the Vite root:

```
@ngrok/app-server found no module at /app/srever.ts for the `app` option. Give a path from the Vite root, /app.
```

Before, `start` printed its URLs, and then each request got a 500 with `Failed to load url … in virtual:@ngrok/app-server/entry`. A build already failed for such a path, and it now fails with the same error. A path with no extension, such as `app: "server"`, still works.

```ts
// Before: `start` printed its URLs, and each request got a 500.
// After: `start` stops with the error.
appServer({ app: "./srever.ts" });

// The fix: give the path of the module.
appServer({ app: "./server.ts" });
```

If you start `app-server start` before the app module exists, start it again after you make the file.
