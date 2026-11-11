---
"@ngrok/app-server": patch
---

`streamingCompress()` now sends brotli, at quality 4, to a client whose `Accept-Encoding` ranks `br` at least as high as `gzip`, as each browser does. Before, a rendered page always got gzip. Brotli at quality 4 is smaller for the same CPU time: a page of 149 KiB takes 0.60 ms and 7.7 KiB as brotli, and 0.68 ms and 10.6 KiB as gzip. It still flushes after each chunk. On the node host, a page that ends with its first chunk, up to 64 KiB, takes a pooled brotli encoder, as gzip does. On Bun and Deno, each brotli body takes a new encoder, because a reset encoder there loses its quality or gives no bytes.

`HostRuntime` and `SetupInfo` have a new optional `brotli` stream, next to `gzip`. The node host gives both, on Node.js, Bun, and Deno. A host with no `brotli` stream sends gzip, as before.
