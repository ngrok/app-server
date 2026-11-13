---
"@ngrok/app-server": patch
---

The build now writes the gzip and brotli copies of each React Router `.data` file of 1 kibibyte (KiB) or more. Before, the build read the type of a file from its extension alone, so a `.data` file got no copy. The server then compressed the file for each client navigation to a prerendered page. The server now sends the copy, with a `Content-Length`.

For a prerendered `.data` file of 12.4 KB through the pipeline of a React Router build, in process on Node.js 26.13 and macOS, with `Accept-Encoding: gzip, deflate, br, zstd` and 64 requests at a time: 19,164 requests per second become 31,661, the CPU time for each request goes from 125 to 53 microseconds, and the body goes from 464 to 388 bytes. Each number is the median of 5 runs of 20,000 requests, with the two builds in turn. On the vercel host, the function keeps only the brotli copy of such a file: for 300 prerendered pages with a `.data` file of 12 KB to 13 KB each, the client build in the function goes from 4.5 MB to 0.7 MB.

A framework adapter can give the build its content types: `FrameworkBuild` has a new optional `contentTypes` field, with the same value as `contentTypes` of the run side. `reactRouterAdapter()` sets it.
