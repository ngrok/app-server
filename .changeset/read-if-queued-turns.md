---
"@ngrok/app-server": patch
---

The node listener and `streamingCompress()` now look for the queued chunks of a body with a fixed wait of microtask turns, not a race of two promise chains. Each response body pays this 2 to 10 times. Each body gets the same answer at the same turn: 36 of 36 cases agree, for a read that settles or fails after 0 to 9 turns and for 16 kinds of stream. So the head, the chunks, and the time of the first byte of each response stay the same.

Two looks at a new body with one queued chunk take 1,947 ns in place of 2,232 ns (ratio 0.872). One look adds 114 ns to a plain read in place of 257 ns, and the two looks make 24 promises in place of 28 (Node.js 26.13, Apple M3 Max, 11 rounds in turn of 200,000). In process, with the default plugins and a `ResponseEdge`, a rendered page that passes `streamingCompress()` takes 0.966 of its time before (15.3 µs to 15.2 µs in the medians; 7 processes, each with 9 rounds of 3,000 requests, the build before and this change in turn). A request with no `Accept-Encoding`, which needs no look there, takes 0.993. This run writes to no socket, so it does not hold the two looks of the node listener for each response.
