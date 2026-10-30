---
"@ngrok/app-server": patch
---

Send the headers of `securityHeaders()`, `noindex()`, and `buildId()` with each response that Vite answers in development, such as a source module or a `public/` file. Before, Vite sent these responses before the plugins set their headers, so development and production sent different headers.

Add `withHeaderHook(c, next, hook)` for an app plugin that sets a header. The hook runs after the later stages, and in development it also runs before Vite sends its own response. In both modes, the hook of an earlier plugin runs last.
