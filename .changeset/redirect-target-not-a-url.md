---
"@ngrok/app-server": patch
---

`redirects()` no longer answers 500 when the target with the values of the request is not a URL. For example, with `{ from: "/go/*", to: "/*" }`, a request for `/go//%2F` makes the target `//%2F`, which names a host that no URL can have. Such a request now gets no redirect and goes on to the next stage, as each other request whose values break a check does.
