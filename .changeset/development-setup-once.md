---
"@ngrok/app-server": patch
---

In development, the server now makes the setup info of the plugins one time for each server entry, not for each request. The host's `files()` runs one time for an entry. A `setup` that throws still runs again on the next request.

A development request through `defaultPlugins()` that Vite answers costs about 10% less CPU time in the pipeline: 10.1 µs to 9.3 µs. Measured with `fetchDev` in process, as the median of 21 interleaved rounds of 20,000 requests, on Node.js 26.13 and an Apple M3 Max.
