---
"@ngrok/app-server": patch
---

A static file now keeps its compressed copy back when a `beforeStatic` plugin sets `Cache-Control: no-transform` in its header hook. Before, the static stages read only their own headers, so the client got the copy with `no-transform`. The static stages now run each hook on a copy of the headers first, so a hook can run more than once for one request.
