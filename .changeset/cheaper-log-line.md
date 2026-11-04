---
"@ngrok/app-server": patch
---

Each access log line costs about a third less CPU time, with the same bytes in each line. The access log no longer parses a request URL that has no query, and it copies the line's attributes once, not three times. `jsonSink()` keeps the time string of the current second and millisecond, because `toISOString()` cost more than the rest of a line. On Node.js, a line for a small route takes about 1.1 µs, not 1.6 µs, and a line for a browser page about 1.5 µs, not 2.3 µs. Each request's logger is also about 15% cheaper to make.
