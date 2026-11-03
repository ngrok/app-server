---
"@ngrok/app-server": patch
---

`streamingCompress()` now gzips the chunks that a body has queued together as one chunk, up to 16 KiB. Each gzip flush costs more than its bytes, and React queues many small chunks at once. With gzip, a page that renders on each request now gets about 20% to 30% more requests per second on Node.js, and about 10% to 15% more on Bun and Deno. A chunk that comes later still goes out at once.
