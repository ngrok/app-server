---
"@ngrok/app-server": patch
---

With `requestId({ headerName })`, `vercel({ cdnPages })` now gives the CDN each prerendered page that qualifies. Before, a request ID header with another name kept each page in the function, with the reason `the x-correlation-id header changes with the request` in the build log, because the build's check knew only `X-Request-Id`. The check now gets the name from the `requestId()` plugin of the app. A page that the CDN serves has no request ID header, as before.

The check does not know `X-Request-Id` by its name now. If your own plugin sets `X-Request-Id` and the plugin list has no `requestId()`, the function now serves each prerendered page, and the build log gives the reason. The check does the same for each other header that changes with each request.
