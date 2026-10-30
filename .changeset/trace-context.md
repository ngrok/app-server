---
"@ngrok/app-server": patch
---

Log the trace IDs of a valid W3C `traceparent` header as `trace_id` and `span_id` on each log line of the request. `requestId({ datadogTraceIds: true })` also logs `dd.trace_id` and `dd.span_id`, so Datadog connects each line to its trace. Add `accessLog({ attributes })` for the app's own attributes on each request line, and `accessLog({ serverTiming: true })` for a `Server-Timing` header on each HTML document.
