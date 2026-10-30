---
"@ngrok/app-server": minor
---

Add the `securityHeaders()` plugin to `defaultPlugins()`, and add the opt-in `cspNonce({ policy })` plugin.

`securityHeaders()` sets these headers on each response, prerendered pages included. If a response already has one of them, it keeps its own value.

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Cross-Origin-Opener-Policy: same-origin`
- `Strict-Transport-Security: max-age=31536000`, on an HTTPS request only

Breaking change: with `defaultPlugins()`, each response now gets these headers. Before, it got none. `same-origin` breaks a pop-up that uses `window.opener`, such as some OAuth and payment pop-ups. To change a value, set it in the option. `false` turns one header off, and `securityHeaders: false` turns them all off.

```ts
defaultPlugins({
	securityHeaders: { headers: { "Cross-Origin-Opener-Policy": "same-origin-allow-popups" } },
});
```

`Content-Security-Policy` has no default. To stop other sites from putting a page in a frame, set `frame-ancestors 'none'` in it.

`cspNonce({ policy })` sets a `Content-Security-Policy` with a new nonce on each HTML document. Read the nonce from `requestContext()?.cspNonce`, from `appServerContext` in React Router, or from `context.appServer` in TanStack Start. Give it to the render.
