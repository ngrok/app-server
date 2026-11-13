---
"@ngrok/app-server": minor
---

Breaking changes to the build side of the package: the `/vite` and `/react-router` entries, and the adapter contracts `FrameworkBuild` and `HostBuild`. An app that uses `appServer()`, `node()`, `vercel()`, `reactRouterAdapter()`, and `tanstackStartAdapter()` as the README shows needs no change for them.

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
