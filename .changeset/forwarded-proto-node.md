---
"@ngrok/app-server": patch
---

Fix a 500 with `trustForwardedProto` on the node host. A request with an `X-Forwarded-Proto` that differs from the socket's scheme, such as `https` behind a proxy that ends TLS, now gets the trusted scheme, also with a body. A TRACE request keeps its method.
