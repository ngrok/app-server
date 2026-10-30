---
"@ngrok/app-server": minor
---

Add the `privateDocuments()` plugin, the last stage of `defaultPlugins()`. It sets `Cache-Control: private, no-cache` on each HTML document from the app's routes or the framework that has no `Cache-Control`. A shared cache then never keeps a page that the server rendered for one user. A prerendered file and an `/assets/*` file do not change.

Breaking change: with `defaultPlugins()`, a rendered document with no `Cache-Control` now gets `private, no-cache`. Before, it got no `Cache-Control`. A page that a CDN may cache sets its own value, such as `public, max-age=60`, in its loader or route headers. To remove the plugin, filter it out: `defaultPlugins().filter((plugin) => plugin.name !== "private-documents")`.
