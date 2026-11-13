---
"@ngrok/app-server": patch
---

The server no longer keeps the setup info of the plugins in memory after setup. Before, three functions of the server kept it for the life of the process: the framework route, `trailingSlash()`, and `prerendered()`. The info holds the script hashes of each prerendered page, which only `contentSecurityPolicy()` reads, so each HTML file of the client build cost about 410 bytes of heap with no reader.

We measured `heapUsed` after the first request and 6 garbage collections, less `heapUsed` after a warm-up setup, on the node host with `defaultPlugins()`, Node.js 26.13, and an Apple M3 Max. The client build was a build manifest with 4 hashes for each page. A new process ran each measurement, the build before the change and the build after it in turn, 3 times each. Each run gave the same number.

| Pages  | Before   | After    |
| ------ | -------- | -------- |
| 100    | 252 KB   | 212 KB   |
| 1,000  | 627 KB   | 232 KB   |
| 10,000 | 4,381 KB | 261 KB   |

With the `contentSecurityPolicy` option and 10,000 pages, the number goes from 7,281 KB to 3,552 KB, because that plugin keeps its own list of the hashes.

A plugin of your own that uses `info` in its middleware keeps the info in the same way. Take the values that the middleware needs in `setup`, such as `const { files } = info`.
