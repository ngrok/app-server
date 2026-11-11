---
"@ngrok/app-server": patch
---

`streamingCompress()` sends brotli with a 256 KiB window, not 4 MiB, on the node host. Why: Node.js tells V8 the full window of each open encoder, and under load V8 then runs a full garbage collection for every few responses. A rendered page of 19 KB to 67 KB under brotli now gets the same requests per second as under gzip, with about 30% more requests per second than before. A page under 256 KiB gets the same bytes, and a page of 2.7 MB gets about 5% more. Fixes #59.
