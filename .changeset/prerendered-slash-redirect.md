---
"@ngrok/app-server": minor
---

Add the `trailingSlash({ mode })` plugin and the `trailingSlash` option of `defaultPlugins`. Each page now has one URL. A GET or HEAD for a page URL in the other form gets a 308 to the URL in the site's form. The redirect applies to rendered and prerendered pages, and it keeps the query string and the URL encoding of the path.

- `never` (the default): `/x/` and `/x//` go to `/x`.
- `always`: `/x` goes to `/x/`. A file in the client build, such as `/LICENSE`, and a path whose last segment has a dot, such as `/llms.txt`, keep their form.
- `preserve`: no redirect.

Breaking change: with `defaultPlugins()`, a GET or HEAD for `/x/` now gets a 308 to `/x`. Before, it got a 200. Set `trailingSlash: "preserve"` to keep the old behavior.

For TanStack Start, set the same mode in the router, else the redirects loop. `RouterTrailingSlash` from `@ngrok/app-server/tanstack-start` is the router's mode, so `mode satisfies RouterTrailingSlash` fails to type-check when the two modes differ.
