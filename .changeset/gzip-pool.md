---
"@ngrok/app-server": patch
---

On Node.js, a gzip response whose body ends with its first chunk, up to 64 KiB, such as most rendered pages and data responses, uses a zlib stream from a pool. A new zlib stream cost more main-thread time than zlib took to compress a small page. In a one-process A/B with `oha` at 64 connections, a rendered 6 KB page with gzip answers about 16% more requests each second.

The pool keeps up to 16 zlib streams between responses, about 4.3 MiB in all. The gzip bytes of a body depend on that body alone, so a response cannot learn a byte of another response from its own size:

- A stream takes only a body of one chunk, because zlib reads the bytes of an earlier write as history.
- A stream takes only a body at least as long as each earlier body of that stream. zlib keeps its window after a reset, and it reads the bytes after the end of a body.
- Each write ends the deflate stream, so the output does not depend on where the output of earlier bodies stopped in the buffer of zlib.
