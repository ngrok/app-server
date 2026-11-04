---
"@ngrok/app-server": patch
---

On Vercel, a request no longer gets copied to take its scheme from `X-Forwarded-Proto`. The handler gives `@hono/node-server` the request target with the forwarded scheme, so the request gets its `https:` URL when it is made. Each copy had copied every request header two times. In a one-process A/B of the handler with Vercel's proxy headers and `oha` at 64 connections, routes answer 30% to 41% more requests each second.
