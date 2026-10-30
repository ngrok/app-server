# One pipeline for development and production

Run the same plugins in the same order in development and in production. A stage differs only where its job differs, such as Vite in place of the built assets.

**Why:** A bug that shows only in production is found by visitors, not by the developer. When `app-server start` and `app-server serve` share the pipeline, a header, a redirect, or a log line that works in development works in production too.

**Applies to:** code.

**Signs you missed it:**

- An `info.mode === "development"` branch in a plugin that changes a status, a header, or a redirect.
- A plugin that development skips because it is not convenient there.
- A bug report that reproduces only with `app-server serve`.

**In this repo:** `app-server start` runs Vite in middleware mode inside the pipeline. In development, `assets()` gives its paths to the dev server, and `prerendered()` is off because no client build exists. Each exception has a reason in its JSDoc.

**Enforced by:** review.
