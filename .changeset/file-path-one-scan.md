---
"@ngrok/app-server": patch
---

The static stages now check a request path with no `split`. `prerendered()` checks the path of each GET and HEAD before it looks for a file, so each rendered page paid for two arrays and a string for each segment. No answer changes: the old and the new check agree on 3,009,331 generated paths.

The check takes 54 ns in place of 206 ns (ratio 0.263; Node.js 26.13, Apple M3 Max, 15 rounds in turn of 2,000,000 calls, 6 paths). In process, with a `ResponseEdge` as the node listener calls the server (5 processes, each with 9 rounds, the build before and this change in turn): a request that goes on to the framework takes 0.976 of its time before with the default plugins (15.9 µs to 15.8 µs), and 0.955 at a path of 6 segments. With only `assets()` and `prerendered()`, it takes 0.914 (5.2 µs to 4.8 µs), and 0.857 at the longer path.
