---
"@ngrok/app-server": patch
---

`app-server start` prints its URLs as `vite dev` does, in place of a JSON `listening` line:

```
  ➜  Local:   http://localhost:3000/
  ➜  Network: http://192.168.4.33:3000/  en0
```

When the host is every interface, such as `server.host: true`, it prints a `Network` line for each IPv4 (Internet Protocol version 4) interface. Each URL ends with Vite's `base`. The lines go through Vite's logger, so Vite's `logLevel` and `customLogger` apply.

The other log lines of `start`, such as a port in use or a failed request, use the text format of Go's `log/slog`, not JSON:

```
time=2026-11-11T16:50:44.050Z level=INFO msg="port in use, trying the next port" server.port=3333
```

`app-server serve` and the production server still write JSON.
