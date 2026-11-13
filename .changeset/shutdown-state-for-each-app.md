---
"@ngrok/app-server": patch
---

Each app server now has its own stop state and its own `shutdownSignal()`. Before, one pair was shared by each `createServer` app of the process, and each start of a server replaced the signal.

- A `shutdownSignal()` that code read before the server started to listen now aborts at shutdown, such as a signal that a route module read at module load or that a plugin read in `setup`. Before, the start of the server replaced that signal, so it never aborted, and work that waited on it ran until the drain deadline.
- In a request, `shutdownSignal()` is the signal of the app server that serves the request. Outside a request, and on a host with no request storage, it is the signal of the last `createServer` call, as the sink of `logger()` is.
- With two app servers in one process, the shutdown of one no longer makes `/readyz` of the other answer 503, and no longer closes the `eventStream()` responses of the other. An event stream that one server opened before the other started now closes when its own server shuts down.
- In a test, an app from `createServer` answers `/readyz` with 200 after another server of the process shut down. Before, it answered 503.

An app with one server that reads `shutdownSignal()` in a request sees no change.
