---
"@ngrok/app-server": patch
---

`contentSecurityPolicy()` makes the `'self' 'sha256-…'` source list of each prerendered document one time, at startup. Before, its header hook made the list on each run, which is two times for a page with a compressed copy. On Node.js v26.13, one run of the hook on a document with 4 inline scripts costs about 23% less (about 850 ns to 650 ns) and leaves about 930 bytes less garbage: the median of 21 rounds that take turns between the build before and this one, in 3 runs. The policy does not change.
