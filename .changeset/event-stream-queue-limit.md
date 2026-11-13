---
"@ngrok/app-server": minor
---

`eventStream()` now stops a stream whose client does not read it. The events that the client has not read wait in memory. When more than 1 mebibyte (MiB) of events still waits after a turn of the event loop, the next event or heartbeat stops the stream:

- The stream stops with an error. On Node.js, the server logs it as an `unhandled error`.
- The server closes the connection. An `EventSource` then connects again and sends `Last-Event-ID`.
- `signal` aborts, with the error as its `reason`.

A client that reads still gets each event at once. A burst of more than 1 MiB in one turn of the event loop does not stop the stream, because no client can read during the turn. The burst waits in memory until the client reads it.

Before, the events waited with no limit. In a test on Node.js 26.13, one client stopped reading while the producer sent 17 MiB each second. In 3 runs, the memory of the events (`process.memoryUsage().arrayBuffers`) grew by 67.5 MiB to 68.7 MiB in 4 s. Now it grows by 1.2 MiB at most, and the server closes the connection after 1.8 MiB: 1 MiB in the stream, and the rest in the socket.

The limit counts the bytes of the events. On Node.js, each event that waits also takes about 220 bytes of heap, so 1 MiB of events of 100 bytes takes 3.3 MiB. The limit works on Node.js and Deno. On Bun, `Bun.serve` reads the stream ahead of the client and holds the events itself, so the limit does not stop a client that does not read there.

Breaking change: a client that reads slower than the producer sends now loses its stream when more than 1 MiB waits for it. Before, the events waited in memory. If a stream sends a long history, give each event an `id` and send only the events after `Last-Event-ID`, or send the history in another response, such as a JSON response that the page gets before it opens the stream.
