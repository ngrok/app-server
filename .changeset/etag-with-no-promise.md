---
"@ngrok/app-server": patch
---

The static stages now make the ETag of a file with no promise, and they keep the hash of more than one list of `etagPart` values. The text of each ETag stays the same, so a browser cache stays valid after the upgrade.

- An app with a plugin that has an `etagPart` between two static stages, such as after `assets()`, gave its assets and its pages two lists of parts. The server kept the hash of one list, so each static response ran SHA-256 again. It now keeps the hash of up to 16 lists. In process, with a `ResponseEdge` as the node listener calls the server, an asset and a page in turn take 16.4 µs in place of 37.2 µs for each request (ratio 0.433; 5 processes, each with 9 rounds of 3,000 requests, the build before and this change in turn; Node.js 26.13, Apple M3 Max).
- With the default plugins, a hashed asset with a brotli copy takes 0.975 of its time before, a 304 0.970, and an image 0.957 (the median of 3 runs, each with 7 processes, the same method). The asset allocates 0.9 KB less on the heap for each request (45.2 KB to 44.3 KB; 3 runs of 40,000 requests in one process for each build).
- The hex text of the modification time takes 44 ns in place of 350 ns, for each file time, and the lookup of the hash takes 7 ns in place of 84 ns (9 rounds in turn of 2,000,000 calls; the time is for the function of the built package). The whole ETag step takes 147 ns in place of 671 ns. On Bun 1.3, where one conversion of the time takes 30 ns, the hex text takes 54 ns, and the whole ETag step takes 135 ns in place of 337 ns.
