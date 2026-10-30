---
"@ngrok/app-server": minor
---

Add the `cacheControl` option of `prerendered()`, and give each prerendered file a default `Cache-Control`. Before, a file with no captured header got none, and each CDN used its own rules.

- An HTML page, a markdown file, and a data file of the framework, such as a React Router `.data` file, get `public, max-age=0, must-revalidate`. A visitor always sees the newest page, and a 304 keeps it fast.
- Every other file, such as `robots.txt` or an image, gets `public, max-age=3600, stale-while-revalidate=86400`.

A header that the build captured and the `headers` option win over the default. Breaking change: a prerendered file with no captured `Cache-Control` now gets one. To keep the old behavior, set `prerendered({ cacheControl: () => undefined })`. A prerendered page behind auth must set `Cache-Control: private` in its auth plugin.
