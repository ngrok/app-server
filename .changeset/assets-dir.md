---
"@ngrok/app-server": patch
---

`assets()` and the `vercel` host use Vite's `build.assetsDir`. The `appServer` Vite plugin records its URL path in `.app-server.json`, so the hashed files get `Cache-Control: public, max-age=31536000, immutable` wherever `build.assetsDir` puts them. With `build.assetsDir: "blog-assets/build"`, `/blog-assets/build/*` gets the immutable cache, and on Vercel the CDN serves it with no `cdnPaths` entry. A build from an earlier version keeps `/assets/`.

A host's `output` also gets `assetsPath`, the URL path of `build.assetsDir`.
