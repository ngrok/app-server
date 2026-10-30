---
"@ngrok/app-server": minor
---

Add the `bodyLimit({ maxBytes })` plugin and the `bodyLimit` option of `defaultPlugins`. If a request body passes the limit, the client gets a 413. The body still streams to the app, and the plugin does not read it into memory. A `maxBytes` that is not a whole number of 0 or more stops startup. The "Limits" README section says what happens when the app streams the body into its response.

Breaking change: with `defaultPlugins()`, a request body over 10 MiB now gets a 413. Before, the server had no limit. Set `defaultPlugins({ bodyLimit: 50 * 1024 * 1024 })` for a larger limit, or `bodyLimit: false` to keep the old behavior.
