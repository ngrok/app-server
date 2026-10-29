# Migrate callers, then delete

When you replace an API, move every caller to the new one, then remove the old one in the same change. Do not leave two paths that do the same job.

**Why:** A kept old path is a second API to document, test, and fix. Callers keep choosing it, so it never goes away.

**Applies to:** code.

**Signs you missed it:**

- A `@deprecated` export that the repo itself still calls.
- An option alias that maps the old name to the new one, with no removal planned.
- A breaking change whose changeset does not tell the app what to change.

**In this repo:** the package is `0.x`, so a breaking change is a `minor`, and its changeset shows the app the change with a before and an after. The callers in this repo are the tests, the fixtures under `test/fixtures`, and the README examples.

**Enforced by:** review.
