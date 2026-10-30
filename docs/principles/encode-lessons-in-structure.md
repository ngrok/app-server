# Encode lessons in structure

When a mistake recurs, turn the lesson into a lint rule, a type, a test, or a script. Prose is the fallback, not the fix.

**Why:** A check runs on every change and needs no reader to remember it. A doc rule depends on someone who reads it at the right time.

**Applies to:** code, prose.

**Signs you missed it:**

- The same review comment on three PRs.
- A doc rule that a lint rule or a type could check.
- A gotcha that lives only in one person's notes or one agent's memory.

**In this repo:**

- The custom oxlint rules in `scripts/oxlint-rules/`, such as `app-server/prefer-null-check`.
- The `src/core` import rule in `.oxlintrc.json`.
- `test/runtimes.ts`, which fails when a runtime is missing, so it cannot pass by skipping one.
- The `appServer` Vite plugin, which fails the build for a CommonJS server build or a `base` other than `/`.

**Enforced by:** the checks it creates.
