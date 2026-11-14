---
"@ngrok/app-server": patch
---

`trailingSlash()` costs less for a request that needs no redirect. It now tests the path before it lists the matched routes and parses the URL, which only a redirect needs. On Node.js v26.13, the stage went from about 600 ns to under 100 ns for each page request in the `never` mode, and from about 700 ns to about 150 ns in the `always` mode. A rendered page through the default plugins with no compression, as on Vercel, costs 3% to 7% less CPU time in the pipeline. The numbers come from requests in one process with no socket: the median of 21 to 31 rounds that take turns between the build before and this one.

Each redirect is the same as before for a request with a valid `Host` header. Two answers change, each for a GET or HEAD request whose URL the stage no longer parses. That is a request whose path already has the form of the mode, and whose last path segment does not end with a `.` or a `\`.

- A request whose URL does not parse, as with a `Host: 1.2.3.4.5` header, got a 500 from this stage. It now goes on to the next stage.
- On Deno, the URL of a request has the `Host` header as the client sent it. With a `\` in that header, the parsed URL has a different path: for `GET /` with `Host: a\b`, the path `/b/`. The request got the redirect for the parsed path, a 308 to `/b` in the `never` mode. It now goes on to the next stage.
