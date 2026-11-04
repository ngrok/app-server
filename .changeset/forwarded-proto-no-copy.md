---
"@ngrok/app-server": patch
---

With `trustForwardedProto`, a request on the node host's listener no longer gets copied to take its scheme from `X-Forwarded-Proto`, as on Vercel. The listener builds the request with the forwarded scheme. In a one-process A/B on Node.js behind a proxy that ends TLS, with `oha` at 64 connections, routes answer 24% to 39% more requests each second.

For a listener adapter: `Listener.start` gets a second argument, `{ trustForwardedProto }`. A listener that builds each request itself can take the scheme from `X-Forwarded-Proto` then. A listener that takes one argument works as before.
