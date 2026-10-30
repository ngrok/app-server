# Experience first

Judge a change by what the people on the other side get: the visitor who waits for the response, the developer who writes `server.ts`, the operator who reads the logs, and the reader of the changelog.

**Why:** This server exists so that each app does not solve caching, streaming, shutdown, and logs again. A default that is easy to build and wrong for the common app moves that work back to every app. A response that is correct but slow, or a page that breaks after a deploy, fails the visitor.

**Applies to:** code, prose.

**Signs you missed it:**

- A default that is safe for the server and wrong for the common app.
- A plugin that works at only one position in the pipeline, with no error at another position.
- A visitor who sees a failed navigation, a blank page, or a reload that they did not cause.
- A log line that an operator cannot act on, or a startup error that does not name the bad value.
- A changeset that describes the diff and not what changes for the app.

**In this repo:** the README lists what the server fixes in `@react-router/serve`. Each item is an experience that the server owns.

**Enforced by:** review.
