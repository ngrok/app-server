---
"@ngrok/app-server": patch
---

`@ngrok/app-server` exports the types `StaticPage` and `CdnPage`. `staticPages()` of an `AppServerEntry` yields them, and an adapter could not name them before. The README section "Adapters" says what a host calls on the entry: `start`, `fetch`, `staticPages()`, and `stopPlugins()`.
