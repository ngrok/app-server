# Derive, don't sync

Compute a value from the source that already holds it. Do not copy it into a second place and keep the two in step.

**Why:** Two copies of one fact disagree sooner or later. In a server, the copy that drifts is often a cache: a 304 that keeps an old response, or a header that the build recorded before the code changed.

**Applies to:** code.

**Signs you missed it:**

- An ETag, a cache key, or a `Vary` that leaves out an input that changes the response.
- A module-level copy of a value that a request or `setup` can read from its source.
- A hand-written list of paths, files, or headers that the build can record.

**In this repo:** a plugin returns `etagPart`, so the ETag of a static file changes with each run-time value that changes the response. The `appServer` Vite plugin records the prerendered paths and headers in `.app-server.json`, so nobody lists them by hand.

**Enforced by:** review.
