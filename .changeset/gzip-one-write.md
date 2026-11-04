---
"@ngrok/app-server": patch
---

On Node.js, a gzip response takes one socket write less when its body ends by the time the gzip stream finishes the last chunk: that chunk and the gzip trailer go out as one. In a one-process A/B on Node.js with a stub renderer, a page of 6 KB before gzip that the renderer queues at once answers about 5% more requests each second, and a page that streams its shell first about 4% more. That is about 3 µs less server time for each response, so a page with a slower render gains a smaller share.
