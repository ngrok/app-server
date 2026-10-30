---
"@ngrok/app-server": patch
---

Add the `securityHeaders()` and `cspNonce({ policy })` plugins.

- `securityHeaders()` sets `X-Content-Type-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, a `frame-ancestors 'none'` policy, and `Strict-Transport-Security` on HTTPS. A response keeps its own value, and `false` turns a header off. It is not in `defaultPlugins()`.
- `cspNonce({ policy })` makes a random nonce for each request that reaches the app or the framework, and sets the `Content-Security-Policy` on each HTML document. Read the nonce from `requestContext()?.cspNonce`, from `appServerContext` in React Router, or from `context.appServer` in TanStack Start, and give it to the render.
