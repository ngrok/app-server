---
"@ngrok/app-server": minor
---

Add the `securityHeaders()` plugin to `defaultPlugins()`, and add the `cspNonce({ policy })` plugin.

`securityHeaders()` sets these headers on each response, prerendered pages included. A response that has one of them keeps its own value.

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Cross-Origin-Opener-Policy: same-origin`
- `Strict-Transport-Security: max-age=31536000`, on an HTTPS request only

Breaking change: with `defaultPlugins()`, each response now gets these headers. Before, it got none. `same-origin` breaks a pop-up that uses `window.opener`, such as some OAuth and payment pop-ups. To change a value or turn a header off:

```ts
defaultPlugins({
	securityHeaders: { headers: { "Cross-Origin-Opener-Policy": "same-origin-allow-popups" } },
});
```

Set `securityHeaders: false` to turn them all off. `Content-Security-Policy` has no default. Set `frame-ancestors 'none'` in it to stop other sites from putting the page in a frame.

`cspNonce({ policy })` makes a random nonce for each request that reaches the app or the framework, and sets the `Content-Security-Policy` on each HTML document. Read the nonce from `requestContext()?.cspNonce`, from `appServerContext` in React Router, or from `context.appServer` in TanStack Start, and give it to the render.
