---
"@ngrok/app-server": patch
---

`eventStream()` formats each event with less work, so `send()` takes less CPU time. On Node.js 26.13 on an Apple M3 Max, `send()` takes about 28% less time for an event with an `event` name and one line of JSON (418 ns to 292 ns), about 29% less for an event with only `data` (360 ns to 247 ns), and about 15% less for an event with `event`, `id`, and three lines of data (501 ns to 426 ns). Each number is the median of 3 runs. Each run has 151 interleaved rounds of 10,240 sends with the built package, against the build before the change. The bytes that go out stay the same.
