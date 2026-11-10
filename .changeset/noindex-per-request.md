---
"@ngrok/app-server": patch
---

`defaultPlugins({ noindex })` and `noindex()` can decide for each request:

- `unlessHeader`: a request with this header gets no `X-Robots-Tag`, and each response gets the header in `Vary`. On the `vercel` host, the CDN serves a prerendered page and picks the answer by the header.
- `when` and `vary`: any rule of the Hono context, with the request headers that it reads. On the `vercel` host, a prerendered page with `when` stays in the function.

```ts
defaultPlugins({ noindex: { unlessHeader: "x-ngrok-edge" } });
```

`noindex: true` still sets `X-Robots-Tag: noindex, nofollow` on each response.
