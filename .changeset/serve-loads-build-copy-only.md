---
"@ngrok/app-server": patch
---

`app-server serve` no longer loads the CLI's own copy of the server for a build from the `appServer` plugin. Such a build runs on its own copy, so the CLI's copy only used time and memory. A plain React Router build, as in `app-server serve build/server/index.js`, still runs on the CLI's copy.

On one build of a React Router app with 301 prerendered pages, with the CLI before and after this change, the time from the start of the process to the `listening` line goes from 104 ms to 92 ms, and the resident set size (RSS) at that time goes from 97.6 MB to 90.9 MB. `node build/server/app-server.js` takes 89 ms and 90.4 MB for that build. Each number is the median of 61 runs on Node.js 26.13 and macOS, with the commands in turn.

An app that builds again with this release gets less of that gain. The build now writes two compressed copies of each `.data` file of 1 kibibyte or more. The node host lists each file of the client build when the server starts, so more files make the start slower. When the build also comes from the same version as the CLI, `serve` goes from 104 ms to 101 ms, and from 97.6 MB to 96.7 MB.
