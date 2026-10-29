---
"@ngrok/app-server": patch
---

`app-server start` tries the next port when its port is in use. Set Vite's `server.strictPort` to stop on a port in use. `app-server serve` does not change: a port in use stops startup.
