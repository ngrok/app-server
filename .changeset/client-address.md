---
"@ngrok/app-server": patch
---

Add the `trustedProxyHops` option of `createServer`. Behind N proxies that add to `X-Forwarded-For`, such as `1` behind the ngrok edge, the access log's `network.client.ip` is now the client's address, not the proxy's. `requestContext()?.clientAddress` gives the same value. For a build with no `server.ts`, set `TRUSTED_PROXY_HOPS`.
