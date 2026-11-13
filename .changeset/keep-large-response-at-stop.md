---
"@ngrok/app-server": patch
---

On Node.js, a stop no longer cuts a large response that still goes out to a slow client. Before, the server ended a body of one or two chunks at once, such as a large `c.json()` answer or a static file that it keeps in memory. Node.js counts such a response as done, and when the server stops, Node.js closes the connection of a done response with the bytes that its socket still holds. So a deploy cut the response, although the drain deadline had time left, and the access log said `http.client_aborted`.

Now, when a body of one or two chunks is 64 KiB or more, the server ends it only after the socket takes it, so the drain waits for it, up to `shutdownDeadlineMs`.

The test ran on Node.js 26.13 with a 32 MiB body of one chunk, a client that reads about 16 MiB each second, and a stop 150 ms after the request. In 3 runs of each build, the client got 3.8, 2.9, and 1.5 MiB before, and the whole 32 MiB now.

The CPU time of the server for each request shows no change above the spread of the test. The numbers are medians of `process.cpuUsage()` for each request, with `oha` on 64 keep-alive connections, and the two builds in turn. Each test has a control route with a small body, which this change does not touch:

- The entry script of the React Router fixture app on the node host, a brotli copy of 67,658 bytes: 46.6, 44.9, 49.9, and 57.4 µs before and 49.3, 45.4, 50.0, and 55.5 µs now, in 4 runs of 15 rounds of 30,000 requests. Each run has new server processes, and the numbers are in the order of the runs. The control, a page of 771 bytes: 37.5, 36.2, 38.7, and 44.6 µs before and 38.5, 36.3, 39.5, and 44.4 µs now.
- A 200 KiB body of one chunk: 130.0 µs before and 132.2 µs now, in 11 rounds of 30,000 requests. The control, a body of 4 bytes: 27.5 µs before and 27.8 µs now.

In the 4 runs of the first test, the entry script took from 3.3% less to 5.8% more CPU time than before, and its control took from 0.4% less to 2.7% more. So the test cannot show a change that is smaller than this spread.
