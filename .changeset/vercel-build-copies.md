---
"@ngrok/app-server": patch
---

On the vercel host, the build now writes only the compressed copies that the deploy holds: the brotli copy of each file that the function serves, and no copy of a file that the CDN serves (a file under `cdnPaths` or Vite's `build.assetsDir`). Before, the build also made a gzip copy of each text file and both copies of each CDN file, and `vercel()` then left them out of `.vercel/output`.

For each file of the client build, `.vercel/output` holds the same file or the same copy with the same bytes, except in one rare case. `build/client` no longer holds a `.gz` copy or a copy of a CDN file.

The rare case is a file whose brotli copy is smaller than the file and not smaller than its gzip copy. The build now keeps a brotli copy when it is smaller than the file. Before, it kept the copy only when it was also smaller than the gzip copy. So for such a file, the function now holds the brotli copy in place of the file and its gzip copy.

For a React Router app with 1,000 prerendered pages (an HTML file of 28 KB and a `.data` file of 12 KB for each page), `react-router build` with `vercel()` spends 656 ms in `gzipSync` and `brotliCompressSync` in place of 1,162 ms, which is 0.56 of the time. So the build saves about 0.5 s for each 1,000 pages. Each number is the median of 5 builds of each version in turn, after one warm-up build, on Node.js 26.13 and macOS, from a preload script that times the two functions. `build/client` holds 2,001 copies (10.1 MB) in place of 4,008 (21.0 MB), and `.vercel/output/static` and the client build in the function have the same SHA-256 before and after.

On the node host, the build writes the same copies with the same bytes, in the same time: 1,124 ms and 1,130 ms in zlib, the median of 3 builds.

For a host adapter: `HostBuild` has a new optional `copies` member. It gets the URL path of a file of the client build and the URL path of Vite's `build.assetsDir`, and it gives the encodings of the compressed copies that the host reads, such as `["br"]`. The build writes no other copy of that file. With no `copies`, the build writes the gzip and the brotli copy.
