---
"@ngrok/app-server": patch
---

The build now writes the gzip and brotli copies of each React Router `.data` file of 1 kibibyte (KiB) or more. Before, the build read the type of a file from its extension alone, so a `.data` file got no copy. The server then compressed the file for each client navigation to a prerendered page. The server now sends the copy as it sends the copy of each other file: with a `Content-Length`, with an ETag for that encoding, and with no byte ranges.

For a prerendered `.data` file of 12.4 KB through the pipeline of a React Router build, in process on Node.js 26.13 and macOS, with `Accept-Encoding: gzip, deflate, br, zstd` and 64 requests at a time: 19,164 requests per second become 31,661, the CPU time for each request goes from 125 to 53 microseconds, and the body goes from 464 to 388 bytes. Each number is the median of 5 runs of 20,000 requests, with the two builds in turn. On the vercel host, the function keeps only the brotli copy of such a file: for an app with 301 prerendered pages, of which 300 have a `.data` file of 12 KB to 13 KB, the client build in the function goes from 4.5 MB to 0.7 MB.

The copies have a cost on the node host. The client build gets two more files for each `.data` file of 1 KiB or more, and the node host lists each file of the client build when the server starts. For the same app, the client build goes from 1,227 files to 1,829. `node build/server/app-server.js` then reaches the `listening` line in 95 ms in place of 89 ms, and its resident set size (RSS) at that time is 95.3 MB in place of 90.4 MB. Each number is the median of 61 runs, with the two builds in turn. The function of the vercel host gets no more files, because the brotli copy takes the place of the file. The build takes more time to write the copies: `react-router build` takes 1.67 s in place of 1.57 s on the node host, and 2.39 s in place of 2.20 s with `vercel({ cdnPages: true })`, as the median of 21 builds.

A framework adapter can give the build its content types: `FrameworkBuild` has a new optional `contentTypes` field, with the same value as `contentTypes` of the run side. `reactRouterAdapter()` sets it.
