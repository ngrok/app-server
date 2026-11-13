---
"@ngrok/app-server": patch
---

A build with a prerender pass no longer does its last step two times. With `appServer` after the framework's plugin, as the README shows, the build wrote the compressed copies of each prerendered file after the pass and again at the end. It also ran the host's `output` at both times, so `vercel({ cdnPages: true })` started the server build two times and printed its report two times. The build now does this work one time, at the end.

For a React Router app with 301 prerendered pages on Node.js 26.13 and macOS, `react-router build` goes from 1.73 s to 1.67 s on the node host, and from 2.96 s to 2.39 s with `vercel({ cdnPages: true })`. Each number is the median of 21 builds, with the versions in turn. Each pair compares the build before and after the changes of this release to the build. Those changes also load `@vercel/nft` later and add the copies of each `.data` file. Without those copies, the build takes 1.57 s on the node host and 2.20 s with `vercel({ cdnPages: true })`.

The build makes 1,210 compress calls, two for each of the 605 files that get copies, and none repeats an input. Before, the build made 1,216 calls for 304 files, so 608 calls repeated an input.

For a host adapter: `output` of `HostBuild` now runs one time, after the build and the prerender pass. With `appServer` before the framework's plugin, the pass runs after the build, so `output` still runs after the build and again after the pass.
