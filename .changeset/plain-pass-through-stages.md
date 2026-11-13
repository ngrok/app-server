---
"@ngrok/app-server": patch
---

A stage that only passes a request on no longer adds a promise to it. `withHeaderHook()` and the stages of `health`, `requestId`, `securityHeaders`, `bodyLimit`, `noindex`, `buildId`, `contentSecurityPolicy`, `trailingSlash`, and `privateDocuments` are now plain functions that return the promise of the next stage. `trailingSlash({ mode: "preserve" })` adds no stage.

On Node.js v26.13, a rendered page through the default plugins makes 98 promises, not 122, and a 404 from the framework leaves 35.7 KB of garbage, not 40.3 KB. A request that reaches the framework costs 3% to 7% less CPU time in the pipeline, and a static file 1% to 3% less. The times come from requests in one process with no socket and no compression, as on Vercel: the median of 31 rounds of 3,000 requests that take turns between the two builds, in 3 runs.

`withHeaderHook()` keeps its signature, and a plugin needs no change. One answer changes, and only for a plugin with a defect: a stage that sends no response and calls no `next()`. With `defaultPlugins()`, that request got a 500 before and gets a 500 now. With a custom plugin list, it can now get a 500 where it got an empty 200.
