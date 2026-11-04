---
"@ngrok/app-server": minor
---

The access log costs less on the node and vercel hosts. The host now counts the body bytes as it gives them to Node.js, so the access log no longer puts a second stream around each body or copies the response. On Node.js, a prerendered page and a hashed asset answer about 3% to 4% more requests each second, and a small route about 1% more.

The line changes in five ways:

- `duration` ends when the response closes, after Node.js gives the last bytes to the socket. For a slow client, it now includes the time to send the body.
- `http.client_aborted` is also set when the client leaves before Node.js sends the last bytes, and when a body ends before its `Content-Length`.
- A body with no `Content-Length` that fails before the server sends the head gets no `http.client_aborted`. `@hono/node-server` ends such a response as complete, and the client gets the same short 200 as before. This happens on vercel, and on node when the response is not gzipped.
- A response that an earlier plugin puts in place of the logged one now gets its line, with the status and bytes that the client got.
- A log sink that throws no longer changes the response. Before, such a sink turned a HEAD request into a 500.

On Bun and Deno, the access log counts the bytes in the pipeline as before.

For a host adapter: `HostRuntime` has an optional `countSent(bindings, report)`. It counts the body bytes that the host sends for a request, and calls `report` once with a `SentBody` when the response ends.

Breaking change for code that builds a `SetupInfo`, such as a plugin test that calls `setup(info)`: set the new `countSent` key.

```ts
// Before
const info: SetupInfo = { files, gzip: undefined, logger /* ... */ };
// After
const info: SetupInfo = { files, gzip: undefined, countSent: undefined, logger /* ... */ };
```
