---
name: simplified-technical-english
description: "Write concise, unambiguous technical prose with the ASD-STE100 Simplified Technical English rules for this repo. Use WHENEVER you write or edit a code comment, JSDoc, a changeset, a README section, an agent doc, a commit message, or a pull request description. Also use when the user asks to tighten, shorten, de-fluff, or clean up any of those. Skip it for chat replies."
---

# Simplified Technical English

These rules are [ASD-STE100](https://www.asd-ste100.org/) Simplified Technical English, adapted to this repo. They are the same rules that the mantle and frontend repos use.

- **In scope:** code comments, JSDoc, `.changeset/*.md`, `README.md`, `AGENTS.md`, `docs/`, commit messages, and PR descriptions.
- **Out of scope:** chat replies, generated files, and quoted upstream text.
- Apply the rules to the prose you write or edit in this task. Do not sweep unrelated prose into the same pull request.

## Words

- **One word, one meaning, within one file.** `stage`, `plugin`, and `middleware` in one paragraph read as three things.
- **Match the code.** Write an identifier with its exact name and casing, in backticks: `createServer`, `etagPart`, `X-Request-Id`. No word rule reaches inside a backtick span.
- **Prefer the short common word:** `use`, `get`, `set`, `add`, `remove`, `keep`, `read`, `write`, `start`, `stop`, `send`.
- **Never write** `utilize`, `facilitate`, `orchestrate`, `basically`, `essentially`, `comprehensive`, `robust`, `ensure`, `simply`, `seamless`, or `leverage`. For `ensure`, write `make sure`, or name the mechanism.
- **Cut the hedges:** `it seems`, `arguably`, `might possibly`, `should probably`. Keep `must`, `can`, `may`, `never`, and `always`.
- **Cap a noun stack at three words.** A backticked identifier counts as one word.
- **Spell out an abbreviation on first use in the file**, unless it is common: `HTTP`, `URL`, `API`, `TLS`, `JSON`, `HTML`, `CSS`, `SSR`, `SPA`, `CDN`, `CLI`, `ID`, `ETag`, `CSP`, `CORS`, `HMR`, `I/O`.

## Sentences

- **Use the active voice.** Write `The server drains open requests.`, not `Open requests are drained.` When the actor is unknown or does not matter, the passive voice is correct.
- **Use simple tenses:** present, past, future, imperative, infinitive. Never use an `-ing` form as the main verb.
- **Put one idea in each sentence.** When both halves stand alone, split the sentence.
- **Put the condition first.** Write `If the deadline passes, the listener closes each socket.`
- **Replace an em-dash aside** with a parenthesis, a colon, a comma, or its own sentence.
- **Do not drop words to shorten.** Keep the articles, subjects, and verbs. A fragment is correct only in a list item, in a JSDoc summary that names a thing, and in a `Why <topic>:` label.
- **Three or more parallel items make a list.**
- **Length is a smell, not a gate.** Procedural text (a commit subject, a step) stays near 20 words, and descriptive text near 25. The limits do not reach `.changeset/*.md`.

## Comments and JSDoc

- State the constraint, the trade-off, or the surprise in one sentence, two at most. Never restate the code or the identifier.
- Use the `Why:` label for a choice: `// Why cancel: Hono drops the body of a HEAD response without a cancel, so a stream would run on.`
- Describe the code as it is now. Never refer to a previous state or a dropped design that the reader cannot see. Never narrate the investigation; that goes in the PR description.
- A JSDoc summary states the contract in one sentence. Then give the inputs, the defaults, the errors, and the side effects that the types do not show. Delete a `@param` or `@returns` that only restates the name or the type.
- An exported function has an `@example` with realistic input.

## Changesets, commits, and PRs

- **A changeset is release notes.** It ships verbatim into `CHANGELOG.md` for an app developer who never reads the diff. Say what changes for the app. A breaking change says what the app must change, with a before and an after.
- **A commit subject** uses the conventional-commit prefix (`feat:`, `fix:`, `chore:`, `docs:`; `!` for a breaking change), the imperative, ten words or fewer after the prefix, and no period.
- **A body states the reason, then the change in behavior.** Never list the changed files.
- **A PR description** has a **Why** section and a **What** section. Add **Limitations** when a part is out of scope. No generated footer and no empty section.

## Before and after

| Instead of                                                                         | Write                                                                      |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `It should be noted that the stream may potentially be buffered by the gzip step.` | `The gzip stream flushes after each chunk.`                                |
| `/** The request ID plugin. It provides request IDs. */`                           | `/** Gives each request an ID and echoes it in the response. */`           |
| `// No longer reads the header here; that design was dropped.`                     | Delete it, or state the current reason.                                    |
| `This PR essentially refactors shutdown in order to facilitate testability.`       | `Split shutdown so a test can stop the listeners without a signal.`        |
| `// handles edge case`                                                             | `// Why: a 304 has no Content-Type, so the build ID must change the ETag.` |

## Self-check

Before you return text, read it for:

- a banned word, a hedge, or a noun stack over three words
- the passive voice where the actor is known, a compound tense, or an `-ing` form as the main verb
- an em-dash aside, a sentence with two ideas, or a condition at the end
- a comment that restates the code, or one that is over two sentences
- a reference to a previous state that the reader cannot see

Fix what you find. Report the check in the `Conventions pass:` note that [AGENTS.md](../../../AGENTS.md#before-you-finish) requires.
