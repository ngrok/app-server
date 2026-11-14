---
"@ngrok/app-server": patch
---

`accessLog` logs a 5xx whose client went away before the app answered as `499` at `info`, not as a 5xx at `error`. Why: React Router gives an aborted request a 500, so each client abort counted as a server error and could trigger a 5xx monitor. A 5xx whose body fails after the head still logs at `error`. The response does not change. An app that changed an aborted 500 to a 499 in its own plugin can remove that plugin.
