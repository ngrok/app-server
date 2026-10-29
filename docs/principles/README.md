# Principles

Each file names one principle: the rule, why it matters, where it applies, the signs that a change missed it, where this repo already states it, and what checks it. [AGENTS.md](../../AGENTS.md#principles) lists them.

A principle never restates its owner doc. The owner doc stays the tie-breaker, and the principle links to it.

When you apply a principle to a change, name it and the decision that it changed. A name with no decision adds nothing.

## Rules for this directory

- Each principle makes sense to a human reviewer with no agent involved.
- Each file has the same six parts: the rule, **Why**, **Applies to**, **Signs you missed it**, **In this repo**, and **Enforced by**.
- Add a principle only when it changes decisions that the existing ones do not cover. Then add it to the list in `AGENTS.md`.

Most principles come from the mantle and frontend repos, with signs and examples for a server. Two are for this server only: [stream, don't buffer](./stream-dont-buffer.md) and [one pipeline for development and production](./one-pipeline.md). The six-part format comes from the principle skills in pstack.
