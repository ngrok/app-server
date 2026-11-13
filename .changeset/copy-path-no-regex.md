---
"@ngrok/app-server": patch
---

The static stages now build the path of a compressed copy with no regular expression. Each static response, a 304 included, built two copy paths with an expression whose time grew faster than the length of the path. No response changes.

One copy path takes 40 ns to 51 ns at each length. Before, it took 249 ns at 21 characters, 750 ns at 39, and 2,115 ns at 96 (Node.js 26.13, Apple M3 Max, 11 rounds in turn of 1,000,000 calls). In process, with the default plugins and a `ResponseEdge` as the node listener calls the server (5 processes, each with 9 rounds of 3,000 requests, the build before and this change in turn): a hashed asset with a brotli copy takes 0.953 of its time before (16.2 µs to 15.5 µs), a prerendered page 0.966, a 304 0.948, an image 0.948, and a page at a file path of 96 characters 0.819 (24.3 µs to 19.9 µs).
