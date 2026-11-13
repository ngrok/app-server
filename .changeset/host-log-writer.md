---
"@ngrok/app-server": patch
---

`import "@ngrok/app-server"` now works on a runtime with no `process` global. Before, the import threw `ReferenceError: process is not defined` there, because the log code of the core set a `process.on("exit")` listener at load. So a host adapter for another runtime, such as Cloudflare Workers, could not load the core.

The code that writes the log lines to standard output (stdout) is now part of the node host. `HostRuntime` has a new optional `logWriter` member, with `write(line)` and `flush()`. `jsonSink()` with no `write`, and the text lines of `app-server start`, go to the `logWriter` of the host. The node host and the vercel host give the writer that the core had. So on Node.js, Bun, Deno, and Vercel, a server writes the same lines in the same order: one write for the lines of one event-loop turn, each line on stdout before the process exits, and each line of a request on stdout before the vercel handler returns.

Two things change:

- With no host, `console.log` writes each line of `jsonSink()`, with one call for each line. This applies to a line that the app logs before `createEntry` runs, such as from `logger()` at module load, and to a test that calls `app.fetch` with no entry. Before, these lines went to `process.stdout.write`, in one write for each turn. A test that reads them from a spy on `process.stdout.write` must spy on `console.log`, or give `jsonSink` a `write` function. `createTestServer` uses the node host, so its lines do not change.
- A host adapter with no `logWriter` gets each line through `console.log` too. A host adapter on Node.js that needs the one write for each turn can give `logWriter: host.logWriter`, with the `host` of `@ngrok/app-server/node`.

A line of the default sink on the node host costs the same: 621 ns against 628 ns for one access log line, with ratios of 0.99, 1.03, and 0.88 in three runs. Each run is the median of 5 samples of 200,000 lines for each build in turn, after one warm-up sample, with stdout to `/dev/null` (Node.js 26.13, macOS, Apple M3 Max). The spread between runs is larger than the difference.
