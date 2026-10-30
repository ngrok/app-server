---
"@ngrok/app-server": patch
---

Add the `redirects(rules)` plugin and the `redirects` option of `defaultPlugins`. Each rule sends a redirect from an old URL path to a new URL, with the query string before the fragment of the target. The first rule that matches wins. A `:name` segment matches one path segment, and a `*` last segment matches the rest of the path, or nothing. An absolute target is percent-encoded as UTF-8. In the query of the target, a value gets `&`, `=`, and `+` encoded. The status is 301 by default, or 308. The table runs before `trailingSlash`, so an old URL gets one redirect. In the `never` mode, a local target loses its trailing slash, so it gets no second redirect. A rule that is not valid stops startup. A target that leaves the site gets no redirect, and neither does a request that is already at the target of its rule.
