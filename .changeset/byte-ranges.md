---
"@ngrok/app-server": minor
---

Answer a `Range` request for a static file. A GET with one `bytes` range gets a 206, and a range past the end of the file gets a 416. Safari now plays a `<video>` from the client build. An HTML file always gets the full page, because `runtimeEnv()` changes its bytes.

Breaking change for a host adapter: `StaticFiles.open` now gets an optional byte range. It must send only the bytes from `range.start` to `range.end`, both inclusive. If an adapter ignores the range, it sends the whole file in a 206, and a keep-alive connection breaks. Before: `open: async (path) => stream(path)`. After: `open: async (path, range) => stream(path, range)`.
