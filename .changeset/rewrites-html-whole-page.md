---
"@ngrok/app-server": patch
---

A `beforeStatic` plugin that sets `rewritesHtml` and changes a prerendered page now sends the page whole on each host. Before, the page kept the `Content-Length` of its file, so the new body did not match it. On the node host, a page under 1 KiB got a 500, and so did each page for a client with no gzip or brotli, or its body stopped early. On the vercel host, each page failed.

With `rewritesHtml`, the static stages now send an HTML page with no `Content-Length`. They also send it with no ETag, and they answer an `If-None-Match` with the full page. Why: the server does not know which values the change depends on, so a 304 could keep a page that the plugin made with an old value. This rule does not apply to the pages of `runtimeEnv`, which keep their ETag and their 304.

The plugin of the changelog (`c.set("rewritesHtml", true)`, then `c.res = addBanner(c.res)`) now gives the page with the banner in 18 of 18 cases, in place of 4 of 18: the node host and the vercel host, pages of 55 bytes, 2.9 KB, and 354 KB, and a client that accepts `identity`, `gzip`, or `br`.
