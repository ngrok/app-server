---
"@ngrok/app-server": patch
---

`@ngrok/app-server/vite` no longer loads `@vercel/nft` at import. The server build loads it in the step that removes the files of a copied package that the build cannot load. So `vite dev`, `app-server start`, and a build with no package to trim do not load it. In a new Node.js 26.13 process on macOS, the import of `@ngrok/app-server/vite` now takes 18 ms in place of 49 ms, and the resident set size (RSS) grows by 9.6 MB in place of 23.9 MB. Each number is the median of 15 runs, with the two builds in turn.
