---
"@ngrok/app-server": patch
---

Add the `redirects(rules)` plugin and the `redirects` option of `defaultPlugins`. Each rule sends a GET or HEAD for an old path to a new URL with a 301 or a 308, and keeps the query string. A rule matches an exact path, `:name` for one segment, and a last `*` for the rest. The first rule that matches wins. The table runs before `trailingSlash` and follows its mode, so an old URL gets one redirect. A rule that is not valid stops startup. The "Redirects" README section has the full rules.
