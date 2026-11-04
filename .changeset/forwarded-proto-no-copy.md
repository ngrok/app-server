---
"@ngrok/app-server": patch
---

With `trustForwardedProto`, a request on the node host's listener on Node.js no longer gets copied to take its scheme from `X-Forwarded-Proto`, as on Vercel. The listener builds the request with the forwarded scheme. In a one-process A/B on Node.js with `oha` at 64 connections, with `X-Forwarded-Proto: https` on each request as a proxy that ends TLS sends it, routes answer 24% to 39% more requests each second.

For a listener adapter: `Listener.start` takes an optional second argument, `{ trustForwardedProto }`. A listener that builds each request itself can take the scheme from `X-Forwarded-Proto` then. A listener that ignores it, and a caller that gives no second argument, work as before.
