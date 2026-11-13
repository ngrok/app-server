---
"@ngrok/app-server": minor
---

The options of the plugins get one name for each job, and a bad value or a bad plugin list now stops startup. Each breaking change has a before and an after.

Breaking change: the option that names the build header is now `headerName` in `buildId()`, `staleBuildReactRouter()`, and `staleBuildTanStack()`, as in `requestId()`. Before, it was `header`. JavaScript ignores the old name with no error, and the server then sends `X-Build-Id` again.

```ts
// Before
defaultPlugins({ buildId: { header: "X-App-Build" } });
staleBuildReactRouter({ header: "X-App-Build" });
staleBuildTanStack({ header: "X-App-Build" });

// After
defaultPlugins({ buildId: { headerName: "X-App-Build" } });
staleBuildReactRouter({ headerName: "X-App-Build" });
staleBuildTanStack({ headerName: "X-App-Build" });
```
