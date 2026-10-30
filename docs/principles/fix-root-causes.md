# Fix root causes

Find the cause of a bug and fix it there. Do not add a guard where the symptom shows.

**Why:** A guard at the symptom hides the cause from the next caller, who hits it again without the guard. The fix at the cause protects every caller at once.

**Applies to:** code.

**Signs you missed it:**

- A `try`/`catch` that swallows an error which the code should never throw.
- A longer timeout or deadline that makes a flaky test pass.
- A branch for one runtime that hides a bug in the shared path.
- A test that mocks away the failing part instead of fixing it.

**In this repo:** a fix comes with a test that fails without it ([AGENTS.md § Rules](../../AGENTS.md#rules)). When one runtime acts differently, the fix goes in its file under `src/node/runtimes/`, and a `Why:` comment names the runtime behavior.

**Enforced by:** review, and the regression test.
