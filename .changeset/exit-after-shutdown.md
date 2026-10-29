---
"@ngrok/app-server": patch
---

`app-server start` and `app-server serve` exit when their shutdown is done. Before, a timer that the app left kept the stopped process alive. The render abort timer in React Router's `entry.server` held it for 6 s after each Ctrl+C or deploy.

On Bun, `app-server serve` now stops at the drain deadline when a response body stays open. Before, the shutdown never finished.
