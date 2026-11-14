---
"@ngrok/app-server": patch
---

The build check of `vercel({ cdnPages })` now compares the two bodies of each prerendered page with a loop. Before, it called a function for each byte. The check gives the same answer for each page.

The compare of two equal bodies takes 39 µs in place of 292 µs at 40 KB, and 366 µs in place of 2,741 µs at 400 KB (ratio 0.13; Node.js 26.13, Apple M3 Max, 9 rounds in turn of 200 calls). The whole check of one page, with the default plugins, takes 109 µs in place of 287 µs at 40 KB (ratio 0.382, 500 pages), and 1.2 ms in place of 3.1 ms at 400 KB (ratio 0.405, 200 pages; 7 rounds in turn of `staticPages()` for each build in one process).
