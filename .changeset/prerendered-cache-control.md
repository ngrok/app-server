---
"@ngrok/app-server": minor
---

Give each prerendered file a default `Cache-Control`, and add the `cacheControl` option of `prerendered()`. Before, a file with no captured header had none, and each CDN used its own rules.

- An HTML page, a markdown file, and a framework data file, such as a React Router `.data` file, get `public, max-age=0, must-revalidate`.
- Each other file, such as `robots.txt` or an image, gets `public, max-age=3600, stale-while-revalidate=86400`.

A captured header and the `headers` option win over the default.

Breaking change: a prerendered file with no captured `Cache-Control` now gets a public value. If a prerendered page is behind auth, set `Cache-Control: private` in its auth plugin. To keep the old behavior, set `prerendered({ cacheControl: () => undefined })`.
