# Keep the hot path lean

Do each piece of work once, at the earliest point that has its input: module scope, then the plugin factory or `setup`, then the request. Code that runs for each request or each chunk does only the work that depends on that request or that chunk.

**Why:** Each request runs the middleware of each plugin, and each chunk of a streamed body runs each transform. A small cost at that point repeats for each request, and it adds to the time to first byte of each page. Work at module scope or in `setup` runs one time for each process.

**Applies to:** code. The hot path is each middleware, each listener, each stream transform, and each function that they call for each request, each chunk, or each event.

**Signs you missed it:**

- A middleware that computes a value from the options or the build only, such as a header value, a parsed option, or a set of paths. Move it to the plugin factory or to `setup`.
- Independent awaits in sequence. Start them together with `Promise.all`. Await in sequence only when a call needs an earlier result, or when the order is part of the contract, such as a check before a body read.
- `Promise.allSettled` when the first match wins. A slow, unrelated read then hides a match. Start the reads together, and await them in order.
- A `Promise.all` whose branch can fail when a retry can start the same work. Let each branch settle before you throw, or the work in flight races the retry.
- One URL that the code parses two times, such as `URL.canParse(x)` then `new URL(x)`, or two plugins that each parse `context.req.url`. Use `URL.parse(x)`, which returns `null` for a URL that is not valid. Give `new URL` a string base, not a parsed `URL`. Parse a constant URL one time, at module scope.
- An allocation for each request or each chunk that one allocation at setup can replace: a closure, an object, an array copy, a `TextEncoder`, or a regular expression from `new RegExp`.
- A data layout that the hot loop does not need. A `Map` for a few fixed keys can be an array index or a `switch`. An array of booleans can be bit flags in one number. An array of objects can be parallel arrays when one loop reads one field of many items. Change a layout only when a benchmark shows the gain.
- A regular expression literal that moves to module scope for speed. V8 keeps the compiled form of each literal, so the gain is small. A module-scope expression with the `g` or `y` flag keeps `lastIndex` between calls, so set `lastIndex` before each `exec`.
- A speedup with no benchmark. See [explain the number](./explain-the-number.md).

**In this repo:**

- Each built-in plugin reads the build in `setup` and keeps the result, such as the build ID in `buildId()` and the script hashes in `contentSecurityPolicy()`.
- `withForwardedProto` checks the scheme before it copies the request, because each copy of a `Request` costs time.
- The build writes the gzip and brotli copies of each text file, so the static stages send bytes and do not compress them for each request.
- `writableHeaders()` copies a response one time, and later header writes change that copy.

**Enforced by:** `app-server/prefer-url-parse`, which finds `URL.canParse(x)` then `new URL(x)` in one function. Review for the rest, with a benchmark for each claim of a speedup.
