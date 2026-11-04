---
"@ngrok/app-server": patch
---

Each request passes the plugins with less work. A plugin step no longer wraps each call in one more async function, and a header hook joins one list for each request, not a new copy of the list. In a one-process A/B on Node.js with `oha` at 64 connections, routes answer 2% to 5% more requests each second.
