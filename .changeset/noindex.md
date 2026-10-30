---
"@ngrok/app-server": patch
---

Add the `noindex()` plugin. It sets `X-Robots-Tag: noindex, nofollow` on each response, so a search engine does not index a preview deploy. For a preview deploy, put it in `beforeStatic`.
