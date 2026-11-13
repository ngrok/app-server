---
"@ngrok/app-server": patch
---

On Node.js, two requests now run the pipeline, with the host `localhost` in the URL: an HTTP/1.0 request with no `Host` header, and a request with an empty `Host` header. Before, each got a 400 with no log line, before the first stage. So an HTTP/1.0 health probe of `/livez`, which HAProxy sends by default, failed with no sign on the server, and the load balancer marked each replica as down.

An HTTP/1.1 request with no `Host` header still gets a 400 from Node.js itself, before the pipeline. On Node.js, a request with a `Host` that is not valid also still gets a 400. Deno already answers a request with no `Host`. On Bun, an HTTP/1.0 request with no `Host` and a request with an empty `Host` still get a 500, so give the probe a `Host` header there.
