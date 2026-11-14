---
"@ngrok/app-server": patch
---

A plugin with no `middleware` and no `etagPart`, such as one with only `setup` and `onShutdown`, no longer costs a pipeline stage for each request. The server gave each plugin a stage, and the stage of such a plugin only passed the request on.

Each such plugin cost about 170 ns of CPU time for each request. With 11 of them and no other plugin, a request costs 4.36 µs before and 2.47 µs after in process, and 24.4 µs before and 22.5 µs after through the node listener over HTTP. Each number is the median of 21 interleaved rounds of 20,000 requests on Node.js 26.13 and an Apple M3 Max. An app with only `defaultPlugins()` sees no change, because each default plugin has a `middleware`.
