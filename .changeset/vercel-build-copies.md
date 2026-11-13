---
"@ngrok/app-server": patch
---

On the vercel host, the build now writes only the compressed copies that the deploy holds: the brotli copy of each file that the function serves, and no copy of a file that the CDN serves (a file under `cdnPaths` or Vite's `build.assetsDir`). Before, the build also made a gzip copy of each text file and both copies of each CDN file, and `vercel()` then left them out of `.vercel/output`.

`.vercel/output` holds the same files with the same bytes. `build/client` no longer holds a `.gz` copy or a copy of a CDN file. The build now keeps a brotli copy there when it is smaller than the file. Before, it kept the copy when it was smaller than the gzip copy. So in the rare case of a brotli copy that is smaller than its file and not smaller than the gzip copy, the function now holds the brotli copy in place of the file and its gzip copy.

For a React Router app with 1,000 prerendered pages (an HTML file of 28 KB and a `.data` file of 12 KB for each page) on Node.js 26.13 and macOS, `react-router build` with `vercel()` spends 647 ms in zlib in place of 1,142 ms, which is 0.57 of the time. The whole build takes 4.05 s in place of 4.74 s. Each number is the median of 5 builds after one warm-up build, with the two versions in turn. The zlib time is the time in `gzipSync` and `brotliCompressSync`, from a preload script that wraps them. The machine ran other work, so the zlib time is the more stable number: an earlier run of the same command gave 642 ms in place of 1,409 ms. `build/client` holds 2,001 copies (10.1 MB) in place of 4,008 (21.0 MB), and `.vercel/output/static` and the client build in the function have the same SHA-256 before and after.

On the node host, the build writes the same copies with the same bytes, in the same time: 1,124 ms and 1,130 ms in zlib, the median of 3 builds.

For a host adapter: `HostBuild` has a new optional `copies` member. It gets the URL path of a file of the client build and the URL path of Vite's `build.assetsDir`, and it gives the encodings of the compressed copies that the host reads, such as `["br"]`. The build writes no other copy of that file. With no `copies`, the build writes the gzip and the brotli copy.
