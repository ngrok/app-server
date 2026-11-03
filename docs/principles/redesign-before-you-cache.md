# Redesign before you cache

Make the slow path fast before you add a cache. Add a cache only when a benchmark shows that it beats the best design with no cache. Then give it a size limit, and derive its key from each input of the result.

**Why:** A cache does work of its own: it computes a key, finds the entry, checks that the entry is still valid, and holds memory in each process. That work can cost more than a design that is fast with no cache. A stale entry sends the wrong bytes. A key that does not hold each input of the result can send the response of one client to a different client. So a cache is a risk to correctness and to security, not only a speedup.

**Applies to:** code.

**Signs you missed it:**

- A `Map` or a module-level value that keeps results across requests with no size limit.
- A memo around work that `setup` can do one time, such as a read from disk or a parse of the same text.
- A validity check, such as a hash, a `stat`, or a parse, that costs about as much as the work that it skips.
- A cache key that does not hold each input of the result, such as a response that the key finds by path when the response changes with `Accept-Encoding` or a cookie.
- A response that a shared cache can keep, with no `Vary` for each request header that changed it.
- A cache with no benchmark of the same path with no cache.

**In this repo:**

- `keptFiles()` keeps each small file of the client build in memory after the first read: up to 256 kibibytes for each file, and up to 32 mebibytes in all. It is correct only because `snapshot()` promises that the client build does not change while the server runs. [Pull request #17](https://github.com/ngrok/app-server/pull/17) measured it.
- The ETag of a response comes from the file and from the `etagPart` of each plugin that the request passed, so a new build ID gives a new ETag. See [derive, don't sync](./derive-dont-sync.md).
- `prefersMarkdown` tells each caller to send `Vary: Accept` on the HTML and on the markdown, so a shared cache does not give the markdown to a browser.

**Enforced by:** review.
