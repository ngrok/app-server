---
"@ngrok/app-server": patch
---

A build with a prerender pass no longer does its last step two times. With `appServer` after the framework's plugin, as the README shows, the build wrote the compressed copies of each prerendered file after the pass and again at the end. It also ran the host's `output` at both times, so `vercel({ cdnPages: true })` started the server build two times and printed its report two times. The build now does this work one time, at the end.

For a React Router app with 300 prerendered pages on Node.js 26.13 and macOS, this change takes `react-router build` from 1.79 s to 1.60 s on the node host, and from 3.06 s to 2.16 s with `vercel({ cdnPages: true })`. Each number is the median of 7 builds, with the two versions in turn. The build makes 1,210 compress calls in place of 2,420.

For a host adapter: `output` of `HostBuild` now runs one time, after the build and the prerender pass. With `appServer` before the framework's plugin, the pass runs after the build, so `output` still runs after the build and again after the pass.
