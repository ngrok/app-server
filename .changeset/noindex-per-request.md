---
"@ngrok/app-server": patch
---

`defaultPlugins({ noindex })` and `noindex()` take `unlessHeader`. A request with this header gets no `X-Robots-Tag`, and each response gets the header in `Vary`, so a CDN keeps one answer for each case. For example, to allow indexing only for a request through the ngrok edge:

```ts
defaultPlugins({ noindex: { unlessHeader: "x-ngrok-edge" } });
```

On the `vercel` host with `cdnPages`, the CDN serves a prerendered page and picks the answer by the header. `noindex: true` still sets `X-Robots-Tag: noindex, nofollow` on each response.
