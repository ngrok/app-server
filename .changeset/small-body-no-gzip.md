---
"@ngrok/app-server": patch
---

`streamingCompress()` no longer gzips a body from a string under 1 KiB, such as `c.text("ok")`. Such a body has no `Content-Length`, so the plugin gzipped it, and gzip made it larger. A small route answers about 55% more gzip requests each second on Node.js. A streamed page still flushes its first chunk at once.
