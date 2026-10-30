---
"@ngrok/app-server": patch
---

Log `trace_id` and `span_id` from a valid W3C `traceparent` header on each log line of the request. With `requestId({ datadogTraceIds: true })`, each line also gets `dd.trace_id` and `dd.span_id`, so Datadog connects the line to its trace.

Add `accessLog({ attributes })` to put the app's own attributes on each request line. Add `accessLog({ serverTiming: true })` to set `Server-Timing` on each HTML document.
