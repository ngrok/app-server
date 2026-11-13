---
"@ngrok/app-server": patch
---

In `app-server start`, an app with no `logger` option now writes its log lines, such as `request` and `unhandled error`, in the text format of Go's `log/slog`, as the other lines of `start` do. Before, those lines were JSON between the text lines of Vite and of `start`.

```
time=2026-11-13T12:00:00.000Z level=INFO msg=request http.method=GET http.url=/ http.status_code=200 network.bytes_written=8 duration=3041084
```

An app that gives `logger` does not change, and production still writes JSON. For JSON in development too, give `logger: jsonSink()`. A line that module code writes with `logger()` before the first request is still JSON. As in JSON, a line has no field for an attribute that is `undefined`.
