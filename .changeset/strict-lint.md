---
"@ngrok/app-server": patch
---

`ListenerBindings.remoteAddress` now accepts `undefined`, so a listener can pass the address that its runtime reports as is.

When the `start` of a listener throws before it returns a promise, `listen()` now stops the listeners that started before it. Before, those listeners kept running.
