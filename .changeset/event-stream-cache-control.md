---
"@ngrok/app-server": patch
---

A `Cache-Control` in the `headers` option of `eventStream()` now goes out. Before, `eventStream()` dropped it and sent `no-cache`. A stream with no `Cache-Control` in `headers` still gets `no-cache`. If your `headers` have a `Cache-Control`, keep `no-cache` in it, or a cache can store the stream.

So one stream can now opt out of compression: with `Cache-Control: no-cache, no-transform`, `streamingCompress()` and each proxy send the stream as it is. Why: a compressed stream holds its encoder until it ends, and a quiet feed that stays open saves few bytes for that memory.

```ts
eventStream({ signal: request.signal, headers: { "Cache-Control": "no-cache, no-transform" } }, produce);
```

We measured 300 open streams of 3 events each on the node host with the default plugins, on Node.js 26.13 and an Apple M3 Max, 3 times each: the resident set size (RSS) of the process with the streams open, less the RSS before, for each stream.

| `Accept-Encoding` | Default        | `no-transform`, before | `no-transform`, now |
| ----------------- | -------------- | ---------------------- | ------------------- |
| `gzip`            | 395 to 408 KiB | 406 to 432 KiB         | 68 to 70 KiB        |
| `br`              | 675 to 713 KiB | 691 to 721 KiB         | 66 to 70 KiB        |

A stream of a client that accepts no compression held 67 to 79 KiB. A quiet stream of 3 events took 751 bytes with `no-transform`, 570 bytes with gzip, and 558 bytes with brotli. The README section "Long-lived responses" now gives the memory of an open stream.
