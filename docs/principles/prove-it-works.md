# Prove it works

Before you report a change as done, run the checks that would catch it if it were wrong, and say what you ran. A claim with no check is a guess.

**Why:** A reviewer cannot rerun your session. The check output is the only evidence that the change does what you say.

**Applies to:** code, prose.

**Signs you missed it:**

- "Should work" or "this fixes it" with no command output.
- A change to a listener, shutdown, or a stream with no `pnpm run test:runtimes` run.
- A change to a header, a status, or a body that nobody saw on a response from the built server.
- A README example that nobody ran.

**In this repo:**

- [AGENTS.md § Before you finish](../../AGENTS.md#before-you-finish).
- `pnpm run test:runtimes` runs the built CLI on Node, Bun, and Deno. Build first.
- For a change that a client sees, build the package, run `app-server serve` on a fixture, and send a request with `curl -i`. Stop the server after.

**Enforced by:** the Vibe Check CI workflow. It runs format, lint, typecheck, tests, the build, and the runtime check.
