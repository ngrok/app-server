---
"@ngrok/app-server": minor
---

Add the `bodyLimit({ maxBytes })` plugin and the `bodyLimit` option of `defaultPlugins`. A request body over the limit gets a 413. A `Content-Length` that is too large gets the 413 before the app runs. A streamed body errors when it passes the limit. When the app reads the body before it answers, the response becomes a 413. When the app streams the body into its response, the response stream errors. The body still streams to the app. A `maxBytes` that is not a whole number of 0 or more stops startup.

Breaking change: with `defaultPlugins()`, a request body over 10 MiB now gets a 413. Before, the server had no limit. Set `defaultPlugins({ bodyLimit: 50 * 1024 * 1024 })` for a larger limit, or `bodyLimit: false` to turn it off.
