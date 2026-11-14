---
"@ngrok/app-server": patch
---

`app-server serve` now writes a message and the usage, with no stack trace, when no file is at the server build path. The process exits with code 1, as before.

```
$ app-server serve nope/app-server.js
No server build at nope/app-server.js. Build the app, or pass its path.
Usage: app-server start [--port <port>] | app-server serve [--port <port>] [build/server/app-server.js]
```

Before, a path with no file gave the runtime's module error with its stack, and `serve` with no path and no build gave the error message with a stack.
