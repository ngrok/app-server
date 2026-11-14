---
"@ngrok/app-server": patch
---

The log now says when the drain deadline cuts open requests. Before, a shutdown that cut a response, such as a streamed answer that ran past `shutdownDeadlineMs`, logged only `draining` and `stopped`.

- When the deadline passes and a listener still has open requests, the server logs one warn line: `the drain deadline passed with open requests`, with `app_server.deadline_ms`. When you see it, raise `shutdownDeadlineMs`, or stop the long responses on `shutdownSignal()`.
- On Node.js, the access line of a response that the deadline cut now comes before the `stopped` line, with `http.aborted: true`. Before, the line came after `stopped`, and with the default `jsonSink()` the exit lost it.

On Bun, a response that the deadline cuts still gets no access line. The exit code of such a shutdown is still 0.
