---
"@ngrok/app-server": patch
---

Answer a `Range` request for a static file. A GET with one `bytes` range gets a 206 with those bytes and a `Content-Range`. A range after the end of the file gets a 416. A request with several ranges or an `If-Range` gets the full 200. Safari now plays a `<video>` from the client build. Each static file sends `Accept-Ranges: bytes`, and `streamingCompress()` removes it from a response that it compresses.

For a host adapter: `StaticFiles.open(path, range)` now gets an optional byte range, and it must give only those bytes.
