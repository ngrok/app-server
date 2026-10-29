---
"@ngrok/app-server": patch
---

`ListenerBindings.remoteAddress` now accepts `undefined`, so a listener can pass the address that its runtime reports as is.
