---
"@ngrok/app-server": patch
---

`accessLog()` changes three things:

- A line with a 5xx status has the level `error`, so Datadog shows the request as an error, and a monitor on error logs finds it. A line with another status keeps the level `info`.
- With React Router, a line has the route pattern that the request matched as `http.route`, such as `/domains/:domainId`. A request that matches no route has no `http.route`. A framework adapter gives the pattern with `c.set("routePattern", pattern)`.
- In development, a request that Vite answers, such as a source module, a CSS file, or `/@vite/client`, gets no line. The dev terminal shows the requests that the app answers.
