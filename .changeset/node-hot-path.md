---
"@ngrok/app-server": patch
---

Each request costs less time on Node.js.

- `jsonSink()` writes the lines of one event-loop turn to stdout in one write, at the end of the turn. Before, each line was its own write. Each line still reaches stdout before the process exits, and before the vercel handler returns. The line format does not change. A `jsonSink(write)` with its own `write` still gets one call for each line.
