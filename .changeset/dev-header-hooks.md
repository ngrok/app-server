---
"@ngrok/app-server": patch
---

In development, a response that Vite answers, such as a source module or a `public/` file, now gets the headers of `securityHeaders()`, `noindex()`, and `buildId()`. Before, these responses did not get them, so development and production sent different headers.

Add `withHeaderHook(c, next, hook)`. An app plugin that sets a header uses it to get the same behavior in development. As in production, the hook of an earlier plugin runs last.
