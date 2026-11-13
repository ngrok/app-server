---
"@ngrok/app-server": patch
---

`accessLog()` redacts the query of a request URL with no URL parse, when each part of the query is `key=value` and each key has only letters, digits, and the characters `-_.!~*'()`. Most queries have this form, such as the `?_routes=…` of a React Router data request. Each other query gets the parse, as before. On Node.js and Bun, the line of a URL that parses is the same.

One line is new. A request whose URL does not parse, as with a `Host: 1.2.3.4.5` header, got no line when its URL had a query. When the query has this form, the line now goes out, as it does for such a URL with no query. With a query of another form, the request still gets no line.

On Node.js v26.13, a request with such a query costs about 1 µs less CPU time. A React Router data request through the default plugins with no compression costs about 6% less in the pipeline. The numbers come from requests in one process with no socket: the median of 21 rounds that take turns between the build before and this one, in 3 runs.

Deno gives each request URL as the client sent it. So on Deno, the line for a URL with such a query now shows the path as the client sent it, as the line for a URL with no query does.
