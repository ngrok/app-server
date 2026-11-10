---
"@ngrok/app-server": patch
---

On the `vercel` host, `vercel({ cdnPages: true })` lets Vercel's CDN serve each public prerendered page, so a page view does not run the function. The default is `false`, so an app that does not set the option gets no change.

```ts
appServer({ host: vercel({ cdnPages: true }) });
```

After the build, `vercel()` starts the server build once and sends each prerendered path through the pipeline. The CDN serves a page when the answer is a 200 from its file, has no cookie and no `private`, `no-store`, or `no-cache`, and is the same for a second client. The second client has another host, address, and query, and it sends a cookie, `Authorization`, `Accept-Language`, and Vercel's geo headers. So a page behind an auth check, or a page that a plugin answers another way for a signed-in visitor or a country, stays in the function. The CDN sends the pipeline's body and headers, so the security headers, the CSP, and the build ID do not change. If the pages need more than Vercel's 2,048 routes, the function serves the rest. The build log names each path that the function serves, with the reason.

With the option on:

- The build runs each plugin's `setup`, so it needs the app's environment.
- A page that the CDN serves writes no access log line and sends no `X-Request-Id`.
- The function still keeps the page's file, for a request that no CDN route matches, such as `/about/` for `/about`.

A function keeps each path that it refuses in the function: `vercel({ cdnPages: (path) => path !== "/" })`.
