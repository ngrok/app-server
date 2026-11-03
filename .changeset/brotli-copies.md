---
"@ngrok/app-server": minor
---

The `appServer` Vite plugin now also writes a brotli copy (`.<file>.br`) next to each gzip copy, when the brotli copy is smaller. `app-server serve` sends the copy that the client's `Accept-Encoding` prefers: brotli, then gzip, then the file. It follows the `q` values, and `q=0` refuses an encoding. In the build of a real docs site, the gzip copies of the 337 scripts are 2.57 megabytes (MB) in all, and the brotli copies are 2.07 MB.

Each encoding of a static file now has its own ETag, such as `W/"5fa9c-19a4e2c8f00-br"`. So a cache that keeps more than one encoding of a file picks the correct one after a 304. A client that holds the ETag of a gzip copy from an earlier version gets one 200 with the new ETag.

`streamingCompress()` now gzips for `Accept-Encoding: *`. It sends the body as it is when `identity` has a higher `q` than gzip.

If you keep the `/assets/*` files of old builds for open tabs, also keep their `.<file>.br` copies.
