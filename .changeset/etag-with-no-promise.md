---
"@ngrok/app-server": patch
---

The static stages now make the ETag of a file with no promise, and they keep the hash of more than one list of `etagPart` values. The text of each ETag stays the same, so a browser cache stays valid after the upgrade.

- An app with a plugin that has an `etagPart` between two static stages, such as after `assets()`, gave its assets and its pages two lists of parts. The server kept the hash of one list, so each static response ran SHA-256 again. It now keeps the hash of up to 16 lists. In process, with a `ResponseEdge` as the node listener calls the server, an asset and a page in turn take 16.8 µs in place of 36.9 µs for each request (ratio 0.453; 5 processes, each with 9 rounds of 3,000 requests, the build before and this change in turn; Node.js 26.13, Apple M3 Max).
- With the default plugins, a hashed asset with a brotli copy takes 0.982 of its time before, a 304 0.985, and an image 0.980 (7 processes, the same method). In one process for each build, the asset takes 13.0 µs in place of 13.6 µs and allocates 0.9 KB less on the heap (3 runs of 40,000 requests). The hex text of the modification time takes 62 ns in place of 342 ns, and the lookup of the hash 7 ns in place of 84 ns (9 rounds of 2,000,000 calls).
