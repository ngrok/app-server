---
"@ngrok/app-server": patch
---

`cspNonce()` from `@ngrok/app-server/client` now gives the nonce of the request when the server has a `document` global. Before, it read the document and gave `undefined`, so `withRequestContext({ cspNonce }, …)` gave no nonce in a jsdom or happy-dom test, and a server with a DOM polyfill rendered each page with no nonce. Outside a request, it reads the document, as before. The browser build does not change.
