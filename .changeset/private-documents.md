---
"@ngrok/app-server": minor
---

Add the `privateDocuments()` plugin as the last stage of `defaultPlugins()`. If a rendered HTML document or a framework data response, such as a React Router `.data` request, has no `Cache-Control`, it gets `private, no-cache`. Then a shared cache never keeps a page or loader data for one user. Prerendered files and `/assets/*` files do not change.

Breaking change: with `defaultPlugins()`, a rendered page with no `Cache-Control` now gets `private, no-cache`. Before, it got none. If a CDN may cache a page, set a value such as `public, max-age=60` in its loader or route headers. A resource route that sends per-user JSON must set its own `Cache-Control`. To remove the plugin, use `defaultPlugins().filter((plugin) => plugin.name !== "private-documents")`.
