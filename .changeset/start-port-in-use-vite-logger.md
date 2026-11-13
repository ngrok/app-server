---
"@ngrok/app-server": minor
---

`app-server start` now reports a port in use as `vite dev` does: in Vite's words, through Vite's logger. So Vite's `logLevel` and `customLogger` apply to the line, as they do to the URL lines.

Breaking change: the two log lines of `start` for a port in use are gone, with their `server.port` and `server.address` attributes. A tool that reads them must read Vite's lines.

- When `start` moves to the next port, it prints `Port 3000 is in use, trying another one...`. Before, it printed `time=… level=INFO msg="port in use, trying the next port" server.port=3000`, also with `logLevel: "silent"`.
- With `server.strictPort`, `start` stops with the error `Port 3000 is already in use`. Before, the error was `listen EADDRINUSE: address already in use …`. That error is now the `cause`.
- With `server.strictPort`, when another server holds the port on a wildcard address, `start` prints Vite's warning for that case. Before, it printed a line with the message `port in use on a wildcard address`.
- When no port from 3000 to 65535 is open, `start` stops with the error `No available ports found between 3000 and 65535`. Before, the error was `No open port from 3000 to 65535.`.
