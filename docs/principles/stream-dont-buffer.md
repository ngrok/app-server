# Stream, don't buffer

Pass a body through as a stream. Read the next chunk only when the client pulls it, and cancel the source when the client goes away.

**Why:** A buffered body costs memory for its full size, and the first byte waits for the last. A streamed SSR page shows its shell at once. A source that nobody cancels runs on after the client leaves, and it can hold the process open at shutdown.

**Applies to:** code.

**Signs you missed it:**

- `await response.text()`, `arrayBuffer()`, or a loop that collects chunks in a plugin.
- A transform that holds its output until its input ends.
- A `ReadableStream` with no `cancel`, or a wrapper that does not pass a cancel to its source.
- A response body that stays open after a HEAD request or a closed socket.

**In this repo:**

- `streamingCompress()` flushes after each chunk.
- The gzip stream and the file stream of the node host read on pull and cancel their source.
- `createServer` cancels the body of a HEAD response, and the node listener cancels a body after its socket closes.

**Enforced by:** the streaming tests, which read a response one chunk at a time; review for the rest.
