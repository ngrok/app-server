# Pure core, effects at the edges

Write parsing, path checks, header logic, and other transforms as small pure functions. Keep I/O, the host, and the framework in the callers.

**Why:** A pure function gives the same output for the same input. A test calls it with a value, with no server, no file system, and no timer. A core with no host code also runs on each host.

**Applies to:** code.

**Signs you missed it:**

- A transform that a test reaches only through a running server.
- A core function that reads `process.env`, `Date.now()`, or the file system instead of taking the value as an argument.
- Node.js or framework code in `src/core`.

**In this repo:** `src/core` imports Hono and nothing else. A host adapter (`src/node`) owns I/O, and a framework adapter owns the framework. `findStaticFile` reads files only through the `StaticFiles` argument that the host gives it.

**Enforced by:** the `eslint/no-restricted-imports` override for `src/core/**` in `.oxlintrc.json`; review for the rest.
