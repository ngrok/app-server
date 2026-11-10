# North star

These are the goals of each change to `@ngrok/app-server`: its code, its options, its defaults, its errors, its logs, and its docs. They are not negotiable, and they apply at all times. No task, deadline, or diff size is a reason to skip one. [AGENTS.md](../AGENTS.md#north-star) lists them, so each human and each agent reads them before the first edit.

The goals have no order. They work together: a change that meets five goals and fails one is not done.

## How to use the goals

- **Before you design:** for each goal, ask what the change does to it. Choose the design that meets all six. The [principles](./principles/README.md) are the methods that get you there.
- **Before you finish:** do a north-star pass. For each goal, say in one line how the change meets it. Put the pass in the pull request (PR) description. The [PR template](../.github/pull_request_template.md) has a section for it.
- **When two goals pull apart:** find a design that meets both. If you cannot, say the trade-off and the reason in the PR. Never trade **Correct**. Never make the trade without a word in the PR.
- **In review:** a goal that a change fails is a blocking finding, as a failed test is.

## Correct

Each response is right on each host (Node, Bun, Deno, and Vercel), with each framework, in development and in production. It is also right at the edges: a shutdown, an aborted client, a stream that errors, a bad config value, and a header in any case. A correct server never gives one client the answer for another client, and it never caches a private page.

- **Served by:** [fix root causes](./principles/fix-root-causes.md), [validate at the boundary](./principles/validate-at-the-boundary.md), [make illegal states unrepresentable](./principles/make-illegal-states-unrepresentable.md), [one pipeline](./principles/one-pipeline.md), [test behavior, not implementation](./principles/test-behavior-not-implementation.md), and [prove it works](./principles/prove-it-works.md).
- **Signs you missed it:** a test that asserts the code and not what a client sees, a check that you did not run, or a default that is safe only for the apps that you tested.

## Least surprising

The server does what an app developer expects from the name of an option and from the README. A safe default is on, and a feature that can change who sees which response is off until the app turns it on. One job has one way to do it. An upgrade never changes the behavior of an app with no word in the changeset, and a breaking change gets a `minor` bump.

- **Served by:** [experience first](./principles/experience-first.md), [one pipeline](./principles/one-pipeline.md), [migrate callers, then delete](./principles/migrate-callers-then-delete.md), and [derive, don't sync](./principles/derive-dont-sync.md).
- **Signs you missed it:** two options that do the same job but act differently, a default that changes what a visitor gets, or a changeset that a developer must read twice.

## Fast

Each request does the least work that its answer needs. Per-request work that only a build step or a rare case needs is a defect. React Router on Node and on Vercel are the deploys that matter most, so measure them first, and never make another deploy slower.

- **Served by:** [keep the hot path lean](./principles/keep-the-hot-path-lean.md), [stream, don't buffer](./principles/stream-dont-buffer.md), [add no round trips to a client navigation](./principles/no-added-round-trips.md), [redesign before you cache](./principles/redesign-before-you-cache.md), and [explain the number](./principles/explain-the-number.md).
- **Signs you missed it:** a claim of speed with no measurement, an allocation for each request that only a build reads, or a body that the server reads into memory to send it.

## Delightful

The visitor gets a fast page that never breaks after a deploy. The app developer gets an option that works on the first try, and an error that names the bad value and the fix. The operator gets a log line that they can act on. The README example runs as it is.

- **Served by:** [experience first](./principles/experience-first.md) and [minimize reader load](./principles/minimize-reader-load.md).
- **Signs you missed it:** a step that each app must remember, a silent failure, or a log that an operator must filter out.

## Clean

The change is the smallest that meets the task, and each part reads in one pass. Each export is API that the project keeps. The core stays pure, and the hosts and frameworks hold the effects.

- **Served by:** [write less code](./principles/write-less-code.md), [subtract before you add](./principles/subtract-before-you-add.md), [reuse before you build](./principles/reuse-before-you-build.md), [minimize reader load](./principles/minimize-reader-load.md), and [pure core, effects at the edges](./principles/pure-core-effects-at-the-edges.md).
- **Signs you missed it:** a helper that already exists in `src/core` or Hono, an option that no app asked for, or a second path for one job.

## Efficient

The server uses few resources outside the request too: memory, the bytes that it sends, the size of the deploy, the build time, and the context window of the next agent. A cost that grows with the app, such as with each page or each route, has a measured limit.

- **Served by:** [keep the hot path lean](./principles/keep-the-hot-path-lean.md), [stream, don't buffer](./principles/stream-dont-buffer.md), [redesign before you cache](./principles/redesign-before-you-cache.md), [explain the number](./principles/explain-the-number.md), and [guard the context window](./principles/guard-the-context-window.md).
- **Signs you missed it:** a deploy that grows with each page and has no limit, a build step that runs work twice, or a doc that each task loads but few tasks need.
