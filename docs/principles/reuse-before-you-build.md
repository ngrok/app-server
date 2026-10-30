# Reuse before you build

Search for an existing helper, Hono middleware, or Web API before you write a new one.

**Why:** A second copy drifts from the first, and a bug fixed in one stays in the other. A reader must also learn two names for one idea.

**Applies to:** code.

**Signs you missed it:**

- A local parser or path check beside one that `src/core` already has.
- Hand-written middleware for a job that Hono already ships, such as `hono/accepts`.
- A new dependency for a job that a Web API does on each host: `crypto.subtle`, `URL`, `Headers`, `ReadableStream`.

**In this repo:** look in `src/core` first, then in the adapter that owns the job. Check `package.json` before you add a dependency.

**Enforced by:** review. The `eslint/no-restricted-imports` override in `.oxlintrc.json` keeps Node.js and framework imports out of `src/core`.
