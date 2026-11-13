---
"@ngrok/app-server": patch
---

`app-server serve` no longer loads the CLI's own copy of the server for a build from the `appServer` plugin. Such a build runs on its own copy, so the CLI's copy only used time and memory. For a React Router build with 302 prerendered pages on Node.js 26.13 and macOS, the time from the start of the process to the `listening` line goes from 98 ms to 88 ms, and the resident set size (RSS) at that time goes from 97.4 MB to 90.8 MB. `node build/server/app-server.js` takes 84 ms and 90.3 MB. Each number is the median of 15 runs, with the three commands in turn. A plain React Router build, as in `app-server serve build/server/index.js`, still runs on the CLI's copy.
