---
"@ngrok/app-server": patch
---

On the node host, the server now lists the client build at start with at most 64 file system calls in flight. Before, it started a `stat` for each file and directory at one time, so a large site needed about 4 KiB of memory for each entry while it started. The list has the same entries.

For a client build of 10,000 prerendered pages (71,004 files and directories), the list takes 497 ms in place of 582 ms (ratio 0.853), and the memory of the process grows by 92 MiB at its peak in place of 292 MiB (ratio 0.314). For 100 pages (1,704 entries), it takes 15.2 ms in place of 16.6 ms, and the memory grows by 8.3 MiB in place of 13.7 MiB. Two more runs of the 100 pages gave ratios of 1.013 and 1.014 for the time, so a small site starts as fast as before. Each number is the first `snapshot()` of a new process, as the median of 7 runs for each build in turn (Node.js 26.13, macOS, Apple M3 Max, with the files in the file cache). The time on Linux is not measured.
