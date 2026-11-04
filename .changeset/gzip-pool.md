---
"@ngrok/app-server": patch
---

On Node.js, a gzip response whose body ends with its first chunk, up to 64 KiB, such as most rendered pages and data responses, uses a zlib stream from a pool. A new zlib stream cost more main-thread time than zlib took to compress a small page. In a one-process A/B with `oha` at 64 connections, a rendered 6 KB page with gzip answers about 16% more requests each second. The pool keeps up to 16 zlib streams between responses, about 4.4 MiB in all. It gives one only to a body of one chunk, because a reused stream can carry bytes of an earlier body into a later write.
