---
"@ngrok/app-server": patch
---

`createServer` now runs the plugins in one Hono middleware, not in one for each plugin. Each plugin, route, and error gets the same answer as before, with less work for each request.

Through `defaultPlugins()`, a request makes 24 fewer promises (110 before, 86 after, counted with `async_hooks`) and about 5 KB less garbage (42 KB before, 37 KB after). In process, the pipeline costs about 15% less CPU time: 8.7 µs before and 7.3 µs after with a framework that answers at once. Through the node listener over HTTP, the `/ping` route of the React Router fixture app costs 5% less server CPU time: 32.8 µs before and 31.2 µs after. A rendered page saves the same 1.4 µs, which is too small to measure: the 6 KB page of the fixture app costs 305 µs. Each time is the median of 21 or 31 interleaved rounds on Node.js 26.13 and an Apple M3 Max that ran other work at the same time.

A request that no stage answers now logs one `unhandled error` line and its access line when an earlier plugin returns the promise of `next()`, as most plugins of `defaultPlugins()` do. Before, it logged six `TypeError` lines and no access line.

`matchedRoutes(c)` from `hono/route` now lists one `/*` route for all the plugins, not one for each plugin.
