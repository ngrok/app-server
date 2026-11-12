---
"@ngrok/app-server": patch
---

On the node host, `streamingCompress()` now picks the brotli window from the size of the body. A body over 256 KiB gets a window of 4 MiB, so a page that repeats data more than 256 KiB back is smaller. A body that ends within 256 KiB keeps the window of 256 KiB, and it now compresses in one zlib call. To pick the window, the stream holds the start of a body until the body ends, goes past 256 KiB, or waits for its next chunk. So a page shell that waits for slow data still goes out at once.
