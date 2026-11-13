---
"@ngrok/app-server": patch
---

On Node.js, a stop no longer cuts a large response that still goes out to a slow client. Before, the server ended a body of one or two chunks at once, such as a large `c.json()` answer or a static file that it keeps in memory. Node.js counts such a response as done, and when the server stops, Node.js closes the connection of a done response with the bytes that its socket still holds. So a deploy cut the response, although the drain deadline had time left, and the access log said `http.client_aborted`.

Now the server ends a body of 64 KiB or more only after the socket takes it, so the drain waits for it, up to `shutdownDeadlineMs`.

Measured on Node.js 26.13 with a 32 MiB body of one chunk, a client that reads about 16 MiB each second, and a stop 150 ms after the request, in 3 runs of each build: the client got 3.8, 2.9, and 1.5 MiB before, and the whole 32 MiB now.

The CPU time of the server for each request did not change. The numbers are medians of `process.cpuUsage()` for each request, with `oha` on 64 keep-alive connections, and the two builds in turn:

- The entry script of the React Router fixture app, a brotli copy of 67,658 bytes: 45.8 µs before and 45.2 µs now, in 15 rounds of 30,000 requests.
- A 200 KiB body of one chunk: 124.0 µs before and 124.8 µs now, in 11 rounds of 30,000 requests.
