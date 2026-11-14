---
"@ngrok/app-server": minor
---

`eventStream()` now throws a `RangeError` for a `heartbeatMs` that a timer cannot hold: `NaN`, a value under 1, or a value over 2,147,483,647. The message names the value. Before, the timer turned such a value into 1 ms with no error. Each open stream then sent a `: ping` comment each millisecond: about 90 comments in 100 ms, in a test on Node.js 26.13.

Breaking change: a route that passes such a value now throws on each request. Before, it sent its stream. `0` and `Infinity` are such values, and they never turned the heartbeat off. Pass a value from 1 to 2,147,483,647. No value turns the heartbeat off, and the largest value is about 24.8 days.
