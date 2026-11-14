---
"@ngrok/app-server": patch
---

`createTestServer` also takes the run side of a framework adapter as `framework`, such as `{ name: "test", fetch, isDataRequest: (path) => path.endsWith(".data") }`. A test can then set `isDataRequest` and `contentTypes`, so a data request gets its production headers, such as `Cache-Control: private, no-cache`. When the `buildId` option has a `value`, a data request also gets `X-Build-Id`, because a test server has no build ID of its own. Before, the test server had no data requests. The function form stays.
