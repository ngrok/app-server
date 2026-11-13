---
"@ngrok/app-server": patch
---

`eventStream()` formats each event with less work, so `send()` takes less CPU time. On Node.js 26.13 on an Apple M3 Max, `send()` takes about 27% less time for an event with an `event` name and one line of JSON (426 ns to 309 ns), about 28% less for an event with only `data` (341 ns to 244 ns), and about 15% less for an event with `event`, `id`, and three lines of data (522 ns to 443 ns). Each time is the median of 3 runs, and each percentage comes from the two times beside it. Each run has 151 interleaved rounds of 10,240 sends with the built package, against the build before the change. The bytes that go out for each event stay the same.
