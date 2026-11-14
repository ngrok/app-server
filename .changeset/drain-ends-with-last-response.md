---
"@ngrok/app-server": patch
---

On Node.js, the drain now ends when the last open response ends. Before, a keep-alive connection that had a request in flight when the drain began stayed open after its response. The server then answered each new request on that connection, waited for the whole `shutdownDeadlineMs` (10 s by default), and reset the request that was in flight at the deadline. So each deploy under load took the whole deadline, and an event stream from `eventStream()` held the drain open, although it closes at shutdown.

Now each response that starts in the drain says `Connection: close`, and the server closes each connection when its last response ends. Bun and Deno already end the drain with the last response.

The test ran on Node.js 26.13 with one request in flight on a keep-alive connection, a handler that answers 200 ms after the drain begins, and `shutdownDeadlineMs: 4000`. In 3 runs of each build, the drain took 4,001 to 4,002 ms before and 205 to 206 ms now.
