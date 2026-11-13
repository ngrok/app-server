---
"@ngrok/app-server": patch
---

On Node.js, a request with no `Host` header now runs the pipeline, with the host `localhost` in its URL. Before, it got a 400 with no log line, before the first stage. So an HTTP/1.0 health probe of `/livez`, which HAProxy sends by default, failed with no sign on the server, and the load balancer marked each replica as down.

A request with a `Host` that is not valid still gets a 400. Deno already answers a request with no `Host`. On Bun, it still gets a 500, so give the probe a `Host` header there.
