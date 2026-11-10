---
"@ngrok/app-server": patch
---

On the `vercel` host, Vercel's CDN serves each public prerendered page. Before, each view of a prerendered page ran the function. The function still keeps the page's file, for a request that no CDN route matches, such as `/about/` for `/about`.

After the build, `vercel()` starts the server build once and sends each prerendered path through the pipeline as an anonymous client. The CDN serves a page when the answer is a 200 from its file, has no cookie and no `private`, `no-store`, or `no-cache`, and is the same for another host, client address, and query. The CDN sends the pipeline's body and headers, so the security headers, the CSP, and the build ID do not change. A page behind an auth check in `beforeStatic` stays in the function, and the CDN never keeps it. If the pages need more than Vercel's 2,048 routes, the function serves the rest. The build log names each path that the function serves, with the reason.

The build now runs each plugin's `setup`, so it needs the app's environment. `vercel({ cdnPages })` keeps paths in the function: `false` keeps each page, and a function keeps each path that it refuses.
