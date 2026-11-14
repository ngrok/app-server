---
"@ngrok/app-server": patch
---

The shutdown log now names the plugin whose `onShutdown` fails or hangs:

- `plugin shutdown failed` has the name of the plugin as `app_server.plugin`, and it goes out when the hook fails. Before, a second plugin whose `onShutdown` hangs held the line back, and the exit at the deadline lost it.
- `plugin shutdown passed the deadline` has `app_server.plugins`, the names of the plugins whose `onShutdown` is still open.
