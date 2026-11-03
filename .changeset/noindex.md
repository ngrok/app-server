---
"@ngrok/app-server": patch
---

Add the `noindex()` plugin. It sets `X-Robots-Tag: noindex, nofollow` on each response, prerendered pages included, so a search engine does not index a preview deploy. Turn it on with the `noindex` option of `defaultPlugins()`:

```ts
defaultPlugins({ noindex: process.env.PREVIEW === "1" });
```
