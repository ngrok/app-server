---
"@ngrok/app-server": patch
---

Add the `trustedProxyHops` option of `createServer`. Set it to the number of proxies that add to `X-Forwarded-For`, such as `1` behind the ngrok edge. Then the access log and `requestContext()?.clientAddress` give the client's address, not the proxy's. For a build with no `server.ts`, set `TRUSTED_PROXY_HOPS`.
