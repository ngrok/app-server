# Test behavior, not implementation

Assert what a caller sees: the status, the headers, the body, a log line, a return value, or when a stream sends its chunks and ends.

**Why:** A test that mirrors the code turns red on each refactor and stays green on a real bug. The team then learns to make the test match instead of reading the failure.

**Applies to:** code.

**Signs you missed it:**

- An assertion on an internal call count or a private variable.
- A mock of Hono's `Context` where `app.request()` can send a real request.
- A constant asserted against a copy of itself.
- A sleep that waits for a stream or a timer.
- A test with no answer to "what one-line change turns this red?"

**In this repo:** tests send requests through `app.request()` or a real listener, and read the response as a client does.

**Enforced by:** oxlint `app-server/no-only-to-be-defined`, `app-server/no-config-teardown`, and `app-server/no-sleep-in-tests`; review for the rest.
