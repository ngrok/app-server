# @ngrok/app-server agent guide

A composable Hono app server for React Router and TanStack Start. One package at the repo root, published to npm with changesets.

## Commands

```sh
pnpm install
pnpm run fmt          # oxfmt; never hand-format
pnpm run lint         # oxlint, type-aware
pnpm run typecheck
pnpm run test         # vitest
pnpm run build        # tsdown into dist/
pnpm run test:runtimes # the built CLI on Node, Bun, and Deno; build first
```

Do not pipe a check through `tail` or `head`: the pipe hides its exit code.

## Rules

- Every published change needs a changeset (`pnpm changeset`). The package is `0.x`: a breaking change is a `minor`, any other change a `patch`.
- Comments, JSDoc, changesets, commits, and PR descriptions use ASD-STE100 Simplified Technical English: active voice, simple tenses, one idea per sentence, one term per concept.
- A comment says why, not what. Start it with `Why:` when it explains a choice.
- Lint turns on every oxlint category. A rule goes off only in `.oxlintrc.json`, with a reason. A suppression comment also gives a reason: `// oxlint-disable-next-line <rule> -- <reason>`.
- Check for no value with `== null` and `!= null`. `eqeqeq` and `app-server/prefer-null-check` reject `=== null`, `=== undefined`, and `== undefined`.
- `src/core` imports Hono and nothing else. Node.js code goes in a host adapter (`src/node`), and framework code goes in a framework adapter (`src/react-router`, `src/tanstack-start`). Lint enforces this.
- The custom lint rules live in `scripts/oxlint-rules/`, one file for each rule, with tests in `scripts/oxlint-plugin-app-server.test.ts`.
- Tests assert behavior that a caller sees. A fix comes with a test that fails without it.
- Stop each process you start, and stage files by path.
