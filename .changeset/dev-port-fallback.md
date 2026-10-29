---
"@ngrok/app-server": patch
---

`app-server dev` tries the next port when its port is in use. Set Vite's `server.strictPort` to stop on a port in use. `app-server start` does not change: a port in use stops startup.
