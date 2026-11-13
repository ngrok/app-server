---
"@ngrok/app-server": patch
---

A prerendered page now keeps its ETag when `runtimeEnv` has public values, so a repeat visit gets a 304 with no body. Before, `runtimeEnv` removed the ETag of each page that it changed. A page has `Cache-Control: public, max-age=0, must-revalidate`, so each visit got the full page, and the node host compressed it again.

- The ETag has the public values, from the `etagPart` of `runtimeEnv`, and the size and the time of the file. A server with other values, and a file that changed, answer the old ETag with a 200 and the new page.
- A rendered document still loses its ETag, because that ETag does not have the values.
- A page with public values gets the ETag of the server, also when the `headers` option of `prerendered()` sets one.
- `runtimeEnv` no longer sets the `rewritesHtml` request value. A page that a plugin with `rewritesHtml` also changes gets no ETag.

In process, with the default plugins and a `ResponseEdge` as the node listener calls the server, a repeat visit to a page of 40 KB takes 12.9 µs in place of 137 µs on the node host (ratio 0.095), and sends no body in place of 2,249 bytes of brotli. With no compression streams, as on the vercel host, it takes 12.3 µs in place of 28.6 µs (ratio 0.445), and sends no body in place of 41,902 bytes. For a page of 400 KB, the ratios are 0.018 and 0.047 (16.8 µs in place of 933 µs, and 12.2 µs in place of 250 µs). Each number is the median of 3 runs of `main` and this change in turn in one process: 9 rounds of 2,000 requests, or 400 for the larger page (Node.js 26.13, Apple M3 Max, with other load on the machine).
