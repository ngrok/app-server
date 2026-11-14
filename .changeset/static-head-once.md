---
"@ngrok/app-server": patch
---

`assets()` and `prerendered()` now build the headers of a file response one time. Before, a response made a `Headers` object from the defaults, made a second one in `prerendered()` for the captured headers and the `headers` option, read and wrote them about 12 times, and then copied them into the response. The headers of each response stay the same. A value of the `headers` option still loses the white space at its ends, a number still becomes text, and a value that no header can hold still gives a 500.

In process, with the default plugins and a `ResponseEdge` as the node listener calls the server (5 processes, each with 9 rounds of 3,000 requests, the build before and this change in turn; Node.js 26.13, Apple M3 Max): a prerendered page with a brotli copy takes 0.885 of its time before, its 304 0.85, a hashed asset with a copy 0.90, its 304 0.855, an image 0.910, a byte range 0.876, and a HEAD 0.902. Other work loaded the machine, so the ratio of one process went from 0.63 to 1.19. The CPU time of the same runs gives 0.84 to 0.94 for each of these requests, and 0.977 for a request that goes on to the framework. The page allocates 3.4 KB less on the heap for each request (50.5 KB to 47.1 KB), and takes 21.0 µs to 22.7 µs of CPU time in place of 23.7 µs to 28.3 µs (3 runs of 40,000 requests in one process for each build).
