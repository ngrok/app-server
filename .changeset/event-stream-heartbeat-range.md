---
"@ngrok/app-server": patch
---

`eventStream()` now throws a `RangeError` for a `heartbeatMs` that is not an integer from 1 to 2,147,483,647, such as `0`, `Infinity`, or `NaN`. The message names the value. Before, the timer turned such a value into 1 ms with no error. Each open stream then sent a `: ping` comment each millisecond: 87 to 90 comments in 100 ms, in a test on Node.js 26.13. If your app passes such a value, pass a value in the range. No value turns the heartbeat off, and the largest value is about 24.8 days.
