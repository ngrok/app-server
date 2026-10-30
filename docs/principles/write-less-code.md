# Write less code

Solve the task with the smallest change that meets it. Every line you add is a line someone must read, test, and keep.

**Why:** Code costs more to keep than to write. Each export, option, and plugin hook is public API. In `0.x`, the removal of one is a `minor` release that each app must handle.

**Applies to:** code, prose.

**Signs you missed it:**

- An option, a mode, or a plugin hook that only the change itself uses.
- A new export that no README section, test, or app needs yet.
- A comment or a README paragraph that restates the code beside it.
- A guard, a retry, or a lock for a race or an attack that nobody can name a concrete failure for.

**In this repo:**

- `src/core` has one dependency, Hono. Keep it that way.
- Before you add complexity for an unlikely race or security edge case, give the person who asked for the change the concrete failure, its likelihood, and the cost. Add it only when they agree.

**Enforced by:** review.
