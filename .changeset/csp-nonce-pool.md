---
"@ngrok/app-server": patch
---

`contentSecurityPolicy()` makes its nonce with less work. On Node.js, one `crypto.getRandomValues` call costs more than the rest of a nonce, and the plugin made one call for each request, assets included. It now gets the random bytes of 64 nonces with one call. Each nonce is still 16 bytes from `crypto.getRandomValues` in base64, and no two nonces share a byte. The bytes that no nonce took yet stay in the memory of the process, as in the entropy cache of `crypto.randomUUID()`.

On Node.js v26.13, the stage went from about 1,200 ns to about 240 ns for each request, and from 1,517 to 876 bytes of garbage. With the option on, a request through the default plugins with no compression costs 6% to 15% less CPU time in the pipeline, for each kind of request. The numbers come from requests in one process with no socket: the median of 21 rounds that take turns between the build before and this one, in 3 runs.
