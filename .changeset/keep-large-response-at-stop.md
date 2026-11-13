---
"@ngrok/app-server": patch
---

On Node.js, a stop no longer cuts a large response that still goes out to a slow client. Before, the server ended a body of one or two chunks at once, such as a large `c.json()` answer or a static file that it keeps in memory. Node.js counts such a response as done, and when the server stops, Node.js closes the connection of a done response with the bytes that its socket still holds. So a deploy cut the response, although the drain deadline had time left, and the access log said `http.client_aborted`.

Now the server ends a body of 64 KiB or more only after the socket takes it, so the drain waits for it, up to `shutdownDeadlineMs`.

The test ran on Node.js 26.13 with a 32 MiB body of one chunk, a client that reads about 16 MiB each second, and a stop 150 ms after the request. In 3 runs of each build, the client got 3.8, 2.9, and 1.5 MiB before, and the whole 32 MiB now.

The CPU time of the server for each request shows no change above the spread of the test, about 5%. The numbers are medians of `process.cpuUsage()` for each request, with `oha` on 64 keep-alive connections, and the two builds in turn. Each test has a control route with a small body, which this change does not touch. The two controls differ by 1% and by 5% between the builds, so the test cannot show a smaller change:

- The entry script of the React Router fixture app, a brotli copy of 67,658 bytes: 48.0 µs before and 45.2 µs now, in 15 rounds of 30,000 requests. The control, a page of 771 bytes: 37.8 µs before and 35.8 µs now.
- A 200 KiB body of one chunk: 130.0 µs before and 132.2 µs now, in 11 rounds of 30,000 requests. The control, a body of 4 bytes: 27.5 µs before and 27.8 µs now.
