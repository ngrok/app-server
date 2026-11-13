---
"@ngrok/app-server": patch
---

`trailingSlash()` costs less for a request that needs no redirect. It now tests the path before it lists the matched routes and parses the URL, which only a redirect needs. On Node.js v26.13, the stage went from about 600 ns to under 100 ns for each page request in the `never` mode, and from about 700 ns to about 150 ns in the `always` mode. A rendered page through the default plugins with no compression, as on Vercel, costs 3% to 7% less CPU time in the pipeline. The numbers come from requests in one process with no socket: the median of 21 to 31 rounds that take turns between the build before and this one.

Each redirect is the same as before. One answer changes: a GET or HEAD request whose URL does not parse, such as one with a `Host: 1.2.3.4.5` header, got a 500 from this stage. When its path needs no redirect, it now goes on to the next stage.
