# @ngrok/app-server agent guide

A composable Hono app server for React Router and TanStack Start. It runs one request pipeline in development and production, on Node, Bun, and Deno. One package at the repo root, published to npm with changesets.

This file follows the [AGENTS.md standard](https://agents.md) and is canonical for every harness. `CLAUDE.md` is a symlink to it; edit `AGENTS.md` only. Every task loads this file, so it holds only what every task needs. [Guard the context window](./docs/principles/guard-the-context-window.md) before you add to it.

## North star

Each change meets all six goals, at all times, for humans and agents alike. They are not negotiable, and they have no order. [docs/north-star.md](./docs/north-star.md) says what each goal means, which principles serve it, and what to do when two goals pull apart.

- **Correct:** right on each host and framework, in development and production, and at the edges. Never trade it.
- **Least surprising:** safe defaults, one way for each job, and no change in behavior without a word in the changeset.
- **Fast:** the least work for each request. Measure React Router on Node and on Vercel first.
- **Delightful:** for the visitor, the app developer, and the operator.
- **Clean:** the smallest change that reads in one pass.
- **Efficient:** few bytes, little memory, a small deploy, a short build, and a small context window.

Do a north-star pass before you finish: for each goal, one line on how the change meets it. A goal that a change fails is a blocking finding in review.

## Route by task

Read the files for your task before the first edit. Work is incomplete until you check your diff against them.

- **Any code:** [Rules](#rules).
- **`src/core`:** it runs on each host and with each framework. Apply [pure core, effects at the edges](./docs/principles/pure-core-effects-at-the-edges.md), [stream, don't buffer](./docs/principles/stream-dont-buffer.md), and [keep the hot path lean](./docs/principles/keep-the-hot-path-lean.md).
- **A host or framework adapter:** `HostRuntime` and `FrameworkRuntime` in `src/core/types.ts`, and `HostBuild` and `FrameworkBuild` in `src/vite/index.ts`, are the contract.
- **A listener, shutdown, a stream, the CLI, or the build:** also run `pnpm run build` and `pnpm run test:runtimes`.
- **An export, an option, a default, a header, or a status:** update the README section that documents it. Apply [experience first](./docs/principles/experience-first.md).
- **A custom lint rule:** `scripts/oxlint-rules/`, one file for each rule, with tests in `scripts/oxlint-plugin-app-server.test.ts`.
- **A performance change or claim:** apply [explain the number](./docs/principles/explain-the-number.md) and [redesign before you cache](./docs/principles/redesign-before-you-cache.md).
- **Comments, JSDoc, changesets, commits, PR descriptions, and repo markdown:** load the [`simplified-technical-english`](./.claude/skills/simplified-technical-english/SKILL.md) skill.

## Principles

Short, named rules for how to work. They are the methods that meet the [north star](#north-star). Each name links to its full rule. Use the names to steer work and in review. When you apply a principle, name it and the decision it changed. [docs/principles/README.md](./docs/principles/README.md) explains the format.

- [Write less code](./docs/principles/write-less-code.md) (code, prose): the smallest change that meets the task. Each export is API.
- [Subtract before you add](./docs/principles/subtract-before-you-add.md) (code, prose): remove a cause before you guard it.
- [Reuse before you build](./docs/principles/reuse-before-you-build.md) (code): search `src/core`, Hono, and Web APIs first.
- [Minimize reader load](./docs/principles/minimize-reader-load.md) (code, prose): code and prose that read in one pass.
- [Experience first](./docs/principles/experience-first.md) (code, prose): judge a change by the visitor, the app developer, and the operator.
- [Make illegal states unrepresentable](./docs/principles/make-illegal-states-unrepresentable.md) (code): contracts in types.
- [Name the arguments](./docs/principles/name-the-arguments.md) (code): a public function, option, or hook takes one named object.
- [Pure core, effects at the edges](./docs/principles/pure-core-effects-at-the-edges.md) (code): pure functions in the core, I/O in the adapters.
- [Derive, don't sync](./docs/principles/derive-dont-sync.md) (code): compute ETags, cache keys, and lists from their source.
- [Validate at the boundary](./docs/principles/validate-at-the-boundary.md) (code): parse input once, where it enters. Check config at startup.
- [Migrate callers, then delete](./docs/principles/migrate-callers-then-delete.md) (code): no two paths for one job.
- [Fix root causes](./docs/principles/fix-root-causes.md) (code): fix the cause, not the symptom.
- [Prove it works](./docs/principles/prove-it-works.md) (code, prose): run the check, and say what you ran.
- [Test behavior, not implementation](./docs/principles/test-behavior-not-implementation.md) (code): assert what a client sees.
- [Explain the number](./docs/principles/explain-the-number.md) (code, prose): say how you measured it.
- [Sequence verifiable units](./docs/principles/sequence-verifiable-units.md) (code): small steps, each checked.
- [Encode lessons in structure](./docs/principles/encode-lessons-in-structure.md) (code, prose): a check beats a doc rule.
- [Guard the context window](./docs/principles/guard-the-context-window.md) (code, prose): load only what the task needs.
- [Stream, don't buffer](./docs/principles/stream-dont-buffer.md) (code): read on pull, flush each chunk, cancel the source.
- [Keep the hot path lean](./docs/principles/keep-the-hot-path-lean.md) (code): do work once, at setup. Per request, start independent work together and parse once.
- [Redesign before you cache](./docs/principles/redesign-before-you-cache.md) (code): a cache must beat the best design with no cache, in a benchmark.
- [One pipeline for development and production](./docs/principles/one-pipeline.md) (code): a stage differs only where its job differs.
- [Stay close to Vite](./docs/principles/stay-close-to-vite.md) (code, prose): `app-server start` acts and prints as `vite dev` does.
- [Add no round trips to a client navigation](./docs/principles/no-added-round-trips.md) (code): a client navigation makes only the router's requests.

## Rules

- Every published change needs a changeset (`pnpm changeset`). The package is `0.x`: a breaking change is a `minor`, any other change a `patch`.
- A comment says why, not what. Start it with `Why:` when it explains a choice.
- Lint turns on every oxlint category. A rule goes off only in `.oxlintrc.json`, with a reason. A suppression comment also gives a reason: `// oxlint-disable-next-line <rule> -- <reason>`.
- Check for no value with `== null` and `!= null`. `eqeqeq` and `app-server/prefer-null-check` reject `=== null`, `=== undefined`, and `== undefined`.
- `src/core` imports Hono and nothing else. Node.js code goes in a host adapter (`src/node`), and framework code goes in a framework adapter (`src/react-router`, `src/tanstack-start`). Lint enforces this.
- Tests assert behavior that a caller sees. A fix comes with a test that fails without it.

## Before you edit

- Search before you create a helper, a parser, a plugin, or a dependency. Look in `src/core` first.
- Other sessions can work in the same checkout. Run `git status` before you stage, and stage by path. Never `git add -A`.
- Do not revert a working-tree change you did not make. Ask first.

## Before you finish

Run checks when a coherent unit of work is done and again before the final response, not after each edit.

1. Read `git diff` for your files. Check them against the files that [Route by task](#route-by-task) names, and fix the drift.
2. Run `pnpm run fmt`, `pnpm run lint`, `pnpm run typecheck`, and `pnpm run test`, and make them pass.
3. Stop each process you start: a dev server, a built server, or a test watcher.
4. A published change has a changeset with the bump from [Rules](#rules).
5. Do the [north-star pass](#north-star), and put it in the PR description. Name the principles you applied and the decision each one changed. End with a `Conventions pass:` note that says what you checked. If you did not run a check, say why.

## Commands

```sh
pnpm install
pnpm run fmt          # oxfmt; never hand-format
pnpm run lint         # oxlint, type-aware
pnpm run typecheck
pnpm run test         # vitest
pnpm run build        # tsdown into dist/
pnpm run test:runtimes # the built CLI on Node, Bun, and Deno; build first
pnpm run bench        # requests per second of the fixture apps on each runtime; build first, needs oha from mise
```

Do not pipe a check through `tail` or `head`. The pipe returns the exit code of the last command, so a failed check looks green. Set `pipefail` or redirect to a file instead.
