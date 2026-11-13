---
"@ngrok/app-server": patch
---

In `eventStream()`, `send()` now throws a `TypeError` that names the type when the `data` of an event is not a string, such as ``An event's `data` must be a string, not undefined.`` The usual cause is `JSON.stringify()`, which gives `undefined` for a value that it cannot write. Before, the message did not name `data`. A `String` object went out before, and it also throws now.
