# Minimize reader load

Write code and prose that a reader understands in one pass. Choose plain names, early returns, short sentences, and one idea for each unit.

**Why:** Code is read far more often than it is written. Every clever line costs each later reader the time it saved the writer.

**Applies to:** code, prose.

**Signs you missed it:**

- A nested ternary, or a boolean positional argument.
- A short name for anything that lives past one line.
- A comment that explains confusing code instead of a rename that removes the confusion.
- A plugin whose effect depends on a stage that the reader cannot see from its call site.
- A sentence with two independent ideas, or a condition at its end.

**In this repo:** [AGENTS.md § Rules](../../AGENTS.md#rules) and the [`simplified-technical-english` skill](../../.claude/skills/simplified-technical-english/SKILL.md).

**Enforced by:** oxfmt; oxlint with `app-server/descriptive-names`, `app-server/no-boolean-positional-param`, and `eslint/max-params`; review for the rest.
