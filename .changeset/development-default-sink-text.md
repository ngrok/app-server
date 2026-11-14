---
"@ngrok/app-server": minor
---

In `app-server start`, an app with no `logger` option now writes its log lines, such as `request` and `unhandled error`, in the text format of Go's `log/slog`, as the other lines of `start` do. Before, those lines were JSON between the text lines of Vite and of `start`.

```
time=2026-11-13T23:03:26.685Z level=INFO msg=request http.request_id=c6cb08cb-7c9b-42ee-970d-cd6a70d3f562 http.method=GET http.url_details.path=/ http.url=/ http.status_code=200 http.useragent=curl/8.7.1 network.client.ip=::1 network.bytes_written=8 duration=4926083
```

Breaking change: a tool that reads the lines of `app-server start` as JSON no longer gets JSON from an app with no `logger` option. For JSON in development too, give `logger: jsonSink()`.

```ts
// Before: JSON lines in development and in production.
createServer({ plugins: defaultPlugins() });

// After: for JSON lines in development too.
createServer({ plugins: defaultPlugins(), logger: jsonSink() });
```

An app that gives `logger` does not change, and production still writes JSON. A line that module code writes with `logger()` before the first request is still JSON. As in JSON, a line has no field for an attribute that is `undefined`.
