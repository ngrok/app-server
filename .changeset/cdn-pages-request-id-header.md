---
"@ngrok/app-server": patch
---

With `requestId({ headerName })`, `vercel({ cdnPages })` now gives the CDN each prerendered page that qualifies. Before, a request ID header with another name kept each page in the function, with the reason `the x-correlation-id header changes with the request` in the build log, because the build's check knew only `X-Request-Id`.

`requestId()` now sets no header on a request of the build's check, as `accessLog()` writes no line for it. A page that the CDN serves has no request ID header, as before.

The check costs each request one property read, and no time that a benchmark shows. Measured on Node.js 26.13 on an Apple M3 Max, with one build with and without the change: one request through `[requestId()]` to a Hono route, with no listener, takes 3,055 ns before and 3,028 ns after. Each number is the median of 5 runs in turn, and each run is the median of 9 rounds of 200,000 requests. The runs differ from each other by up to 8%.
