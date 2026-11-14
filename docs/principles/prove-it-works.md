# Prove it works

Before you report a change as done, run the checks that would catch it if it were wrong, and say what you ran. A claim with no check is a guess.

**Why:** A reviewer cannot rerun your session. The check output is the only evidence that the change does what you say.

**Applies to:** code, prose.

**Signs you missed it:**

- "Should work" or "this fixes it" with no command output.
- A change to a listener, shutdown, or a stream with no `pnpm run test:runtimes` run.
- A change to a header, a status, or a body that nobody saw on a response from the built server.
- A README example that nobody ran.
- A sentence about a drain, a timeout, or a stream that you saw on Node.js only. Run it on Bun and Deno, or name the runtime in the sentence.
- A defect that you fix before you see it fail. Run the report first: a dependency or an earlier change can have fixed it.
- An example of output, such as a log line, that no run of the real command gave.
- A test that passes on your machine because of a file outside the repo, such as a `package.json` in the temp directory. Give the test each file that it needs.

**In this repo:**

- [AGENTS.md § Before you finish](../../AGENTS.md#before-you-finish).
- `pnpm run test:runtimes` runs the built CLI on Node, Bun, and Deno. Build first.
- For a change that a client sees, build the package, run `app-server serve` on a fixture, and send a request with `curl -i`. Stop the server after.
- `test/docs.test.ts` type-checks each `ts` example of the README, runs the auth example, and compares the log table, the plugin names, and the install line with the code.

**Enforced by:** the Vibe Check CI workflow. It runs format, lint, typecheck, tests, the build, and the runtime check. `test/docs.test.ts` fails for a README example that does not compile.
