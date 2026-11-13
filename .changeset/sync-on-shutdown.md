---
"@ngrok/app-server": patch
---

The `onShutdown` of a plugin can now return nothing, as `setup` can. Before, the type asked for a promise, so a cleanup with no `await`, such as `() => { clearInterval(timer); }`, needed `async`. The server already ran such a hook. Code that calls the `onShutdown` of another plugin must `await` the result, because it can be `undefined`.
