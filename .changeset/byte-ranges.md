---
"@ngrok/app-server": minor
---

Answer a `Range` request for a static file. A GET with one `bytes` range gets a 206 with those bytes and a `Content-Range`. A range after the end of the file gets a 416. A request with several ranges or an `If-Range`, or a range of an HTML file, gets the full 200. Why HTML: `runtimeEnv()` adds a script to a page, so a range of the file is not a range of the page. Safari now plays a `<video>` from the client build. Each static file that is not HTML sends `Accept-Ranges: bytes`, and `streamingCompress()` removes it from a response that it compresses.

Breaking change for a host adapter: `StaticFiles.open(path, range)` now gets an optional byte range, and it must give only the bytes from `range.start` to `range.end`, both inclusive. An adapter that ignores `range` still type-checks, but it sends the whole file in a 206, and a keep-alive connection breaks. Before: `open: async (path) => stream(path)`. After: `open: async (path, range) => stream(path, range)`.
