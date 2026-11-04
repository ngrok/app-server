---
"@ngrok/app-server": patch
---

Add `@ngrok/app-server/testing`, for the tests of an app:

- `createTestServer({ app, files, framework })` starts the app in production mode over a client build of `files`, with no listener. It records the hashes of the inline scripts of each HTML file, as the build does, so a test can check the CSP of a prerendered page.
- `withRequestContext(values, work)` runs `work` with `requestContext()` and `cspNonce()` set to `values`, so a render test needs no mock.

The `bindings` argument of a `FetchHandler`, such as the entry's `fetch`, is now optional.

```ts
const server = await createTestServer({ app, files: { "providers/index.html": html } });
const response = await server.request("/providers");
await server.close();

const rendered = await withRequestContext({ cspNonce: "test-nonce" }, () => renderToString(<App />));
```
