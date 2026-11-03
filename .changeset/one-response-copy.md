---
"@ngrok/app-server": patch
---

The default plugins copy a response at most once to change its headers, not once for each plugin. A small route answers about 10% more requests each second on Node.js. A response object that the app sends again stays unchanged.
