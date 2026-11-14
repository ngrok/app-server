---
"@ngrok/app-server": patch
---

`streamingCompress()` now parses `Accept-Encoding` only for a response that it can compress. A static file with a compressed copy, a 304, a HEAD response, and a body under 1 KiB no longer pay for the parse. No response changes.

One parse takes about 205 ns for Safari's header and about 275 ns for Chrome's (Node.js 26.13, Apple M3 Max, 9 rounds of 1,000,000 calls). In process, with the default plugins and a `ResponseEdge`, as the node listener calls the server (7 processes, each with 9 rounds of 3,000 requests, `main` and this change in turn, on a machine with other load): a hashed asset with a brotli copy takes 0.978 of its time before (18.2 µs to 17.5 µs), a 304 0.973, a HEAD 0.989, and a small text file 0.985. A request with no `Accept-Encoding` takes the same time (0.969 to 1.013).
