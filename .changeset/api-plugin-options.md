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

Breaking change, for a listener that writes each response itself: `ResponseEdge.close` now takes one object, so the call says what each value is. Before, it took three positional values. JavaScript gives no error for the old call: the access log line then has no status.

```ts
// Before
edge.close(status, aborted, head);

// After
edge.close({ status, aborted, head });
```

The object costs about 56 bytes of heap for each response on Node.js and Vercel, and no time that the benchmark shows. Measured on Node.js 26.13 on an Apple M3 Max, with the built `ResponseEdge` of one build and only the `close` line changed: one edge for one response (`new`, `claim`, `useHeaders`, `onSent`, `close`) takes 38.3 ns with each shape, and 957 bytes of heap before against 1,013 bytes after. Each number is the median of 5 runs in turn, and each run is the median of 9 rounds of 3,000,000 edges. For scale, one `/ping` request through `defaultPlugins()` allocates about 38,700 bytes.

Breaking change: `health()` now stops startup for a `livePath` or a `readyPath` that does not start with `/`, and for one path for both probes. Before, a path with no `/` never answered. One path for both probes always answered 200, so `ready` never ran, and the path did not answer 503 at shutdown. The check also finds one option that has the default of the other, such as `readyPath: "/livez"`. For a platform with one health URL, set only `readyPath`.

```ts
// Before
defaultPlugins({ health: { livePath: "/healthz", readyPath: "/healthz", ready } });

// After
defaultPlugins({ health: { readyPath: "/healthz", ready } });
```

The error names the option, the value, and the fix:

```
health needs a livePath and a readyPath that differ. Both are "/healthz", so the readiness check would never run. For one health URL, set only readyPath.
```
