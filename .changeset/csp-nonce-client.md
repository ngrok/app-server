---
"@ngrok/app-server": patch
---

Add `cspNonce()` to `@ngrok/app-server/client`. It gives the CSP nonce of the request on the server, and reads it from the document in the browser, so the hydration matches. React Router's `<HydratedRouter>` takes no nonce, so a page with a CSP nonce got a hydration warning in development. Give `cspNonce()` to `<Links>`, `<ScrollRestoration>`, and `<Scripts>` in the root `Layout`:

```tsx
const nonce = cspNonce();
<Links nonce={nonce} />
<ScrollRestoration nonce={nonce} />
<Scripts nonce={nonce} />
```

In TanStack Start, use `createRouter({ routeTree, ssr: { nonce: cspNonce() } })`.
