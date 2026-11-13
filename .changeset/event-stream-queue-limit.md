---
"@ngrok/app-server": minor
---

`eventStream()` now stops a stream whose client does not read it. The events that the client has not read wait in memory, up to 1 mebibyte (MiB). When more than 1 MiB waits:

- The stream stops with an error. On Node.js, the server logs it as an `unhandled error`.
- The server closes the connection. An `EventSource` then connects again and sends `Last-Event-ID`.
- `signal` aborts, with the error as its `reason`.

A client that reads still gets each event at once.

Before, the events waited with no limit. In a test on Node.js 26.13, one client stopped reading while the producer sent 16 MiB each second. In 3 runs, the memory of the events (`process.memoryUsage().arrayBuffers`) grew by 65 MiB to 67 MiB in 4 s. Now it stays at 1 MiB or less, and the server closes the connection after 1.8 MiB: 1 MiB in the stream, and the rest in the socket.

The limit counts the bytes of the events. On Node.js, each event that waits also takes about 220 bytes of heap, so 1 MiB of events of 100 bytes takes 3.3 MiB. The limit works on Node.js and Deno. On Bun, `Bun.serve` reads the stream ahead of the client and holds the events itself, so the limit does not apply there.

Breaking change: `send()` does not wait for the client, so a producer that sends more than 1 MiB before the client can read it, such as a long replay in one turn of the event loop, now stops its stream. If the burst comes before the first byte of the response, the client gets a 500. Before, the burst waited in memory. Send a long history in another response, such as a JSON response that the page gets before it opens the stream.
