---
"@ngrok/app-server": patch
---

`runtimeEnv` now adds the public values to an HTML document on its bytes. Before, it decoded each chunk of each document to text, searched all the text so far again for each chunk, and encoded the text again.

- A document that is not UTF-8 keeps its bytes. Before, each byte that is not valid UTF-8 became U+FFFD, such as the `é` of an ISO-8859-1 page, and a UTF-8 byte order mark at the start of a document was lost.
- An HTML body with no `</head>` now streams. Before, the server held the body until its end, or until 1 MiB of it. The server now holds only the end of a chunk that can start `</head>`, 6 bytes at most.
- A UTF-8 document with no byte order mark gets the same bytes as before: 260 of 260 runs agree, for 20 documents at 13 chunk sizes. The search for `</head>` still stops after 1 MiB, which it now counts in bytes, not in characters.

The transform alone, for one document, as the median of 3 runs of 31 rounds in turn (Node.js 26.13, Apple M3 Max, with other load on the machine):

- A page of 40 KB in one chunk, with `é` and curly quotes in its text, takes 3.9 µs in place of 31.1 µs (ratio 0.12), and 3.6 KB of V8 heap in place of 172 KB. With only ASCII, where the decoder is fastest, it takes 4.3 µs in place of 6.7 µs (ratio 0.60).
- A page of 250 KB in one chunk takes 13 µs in place of 279 µs, and 3.5 KB of heap in place of 936 KB.
- 256 KB of HTML with no `</head>`, in chunks of 1 KB, takes 0.37 ms in place of 13.2 ms, and 0.3 MB of heap in place of 35 MB.

In process, with the default plugins and a `ResponseEdge` as the node listener calls the server, for a first visit with public values (3 processes, each with 31 rounds in turn of 500 requests, the build before and this change):

- With no compression streams, as on the vercel host: a prerendered page of 40 KB takes 0.90 of its time before (24.6 µs to 22.1 µs), a page of 400 KB 0.76, a page of 6 KB 0.96, and a rendered document of 6 KB the same time (1.00). A page of 36 KB whose head has 30 KB of inline CSS in ASCII, which is the case that helps the search least, takes 0.96.
- On the node host, brotli takes most of the time, and a page of 40 KB takes 0.99 (122 µs to 121 µs).
- An asset and a data request take the same time (0.97 and 1.00 of the CPU time).
