---
"@ngrok/app-server": patch
---

In `eventStream()`, `send()` now throws a `TypeError` that names the type when the `data` of an event is not a string, such as ``An event's `data` must be a string, not undefined.`` The usual cause is `JSON.stringify()`, which gives `undefined` for a value that it cannot write. Before, the error came from a string method, such as `data.split is not a function`. A `String` object went out before, and it also throws now.
